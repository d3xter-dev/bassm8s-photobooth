import { CameraType } from '../types';
import { URL } from 'url';
import net from 'node:net';
import tls from 'node:tls';
import type { Socket } from 'node:net';
import { request, type ClientRequest } from 'http';
import semver from 'semver';
import { EventEmitter } from 'events';
import type {
    CameraState,
    CameraStrategy,
    CaptureResult,
    LiveViewFrameHandler
} from '~~/server/camera/types';
import { loggerCamera as logger, type TaggedLogger } from '~~/server/utils/logger';

const minVersionRequired = '2.0.0';

/** Sony liveview: 8 common + 128 payload header (see Camera Remote API liveview spec). */
const LIVEVIEW_PACKET_HEADER_SIZE = 8 + 128;
/** Fixed start code in payload header (bytes 0–3 of the 128-byte payload header). */
const LIVEVIEW_PAYLOAD_MAGIC = 0x24356879;
const LIVEVIEW_MAX_JPEG_BYTES = 20 * 1024 * 1024;

/**
 * Drain complete liveview packets from an accumulated buffer. TCP may split frames
 * arbitrarily; padding after JPEG or the next header may span chunk boundaries — the
 * previous one-chunk-at-a-time parser misaligned and corrupted subsequent reads.
 */
function parseSonyLiveviewBuffer(
    buffer: Buffer,
    onJpeg: (jpeg: Buffer) => void,
): Buffer {
    let buf = buffer;
    let guard = 0;
    while (buf.length >= LIVEVIEW_PACKET_HEADER_SIZE && guard < 500_000) {
        guard++;
        if (buf[0] !== 0xff || buf[1] !== 0x01) {
            buf = buf.subarray(1);
            continue;
        }
        if (buf.readUInt32BE(8) !== LIVEVIEW_PAYLOAD_MAGIC) {
            buf = buf.subarray(1);
            continue;
        }
        const jpegSize = buf.readUIntBE(12, 3);
        const paddingSize = buf.readUInt8(15);
        if (jpegSize < 1 || jpegSize > LIVEVIEW_MAX_JPEG_BYTES) {
            buf = buf.subarray(1);
            continue;
        }
        const total = LIVEVIEW_PACKET_HEADER_SIZE + jpegSize + paddingSize;
        if (buf.length < total) {
            break;
        }
        const slice = buf.subarray(
            LIVEVIEW_PACKET_HEADER_SIZE,
            LIVEVIEW_PACKET_HEADER_SIZE + jpegSize,
        );
        onJpeg(Buffer.from(slice));
        buf = buf.subarray(total);
    }
    return buf;
}

const HTTP_HEADER_LIMIT = 256 * 1024;

/**
 * First offset after `\r\n\r\n` in buf, or -1 if incomplete.
 */
function findHttpHeaderEnd(buf: Buffer): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
            return i + 4;
        }
    }
    return -1;
}

/**
 * Sony liveview over HTTP: the body is a raw Sony packet stream. Node's `http.request`
 * parses `Transfer-Encoding: chunked`; the first body byte is often 0xff (JPEG packet),
 * which is not valid hex in a chunk-size line → "Parse Error: Invalid character in chunk size".
 * We read the TCP/TLS stream ourselves after the header delimiter.
 */
function connectSonyLiveviewSocket(
    liveviewUrl: URL,
    onJpeg: (jpeg: Buffer) => void,
    onStreamError: (e: Error) => void,
    onStreamClosed: () => void,
): Socket {
    const host = liveviewUrl.hostname;
    const isHttps = liveviewUrl.protocol === 'https:';
    const port = liveviewUrl.port
        ? parseInt(liveviewUrl.port, 10)
        : isHttps
          ? 443
          : 80;
    const pathWithQuery = `${liveviewUrl.pathname}${liveviewUrl.search}`;

    const requestLine =
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Connection: close\r\n' +
        'Accept: */*\r\n' +
        '\r\n';

    const socket: Socket = isHttps
        ? tls.connect({
              host,
              port,
              rejectUnauthorized: false,
          })
        : net.connect({ host, port });

    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    let incoming: Buffer = Buffer.alloc(0);

    const writeRequest = () => {
        socket.write(requestLine);
    };

    if (isHttps) {
        socket.once('secureConnect', writeRequest);
    } else {
        socket.once('connect', writeRequest);
    }

    socket.on('data', (chunk: Buffer) => {
        try {
            if (!headersDone) {
                headerBuf = Buffer.concat([headerBuf, chunk]);
                if (headerBuf.length > HTTP_HEADER_LIMIT) {
                    socket.destroy();
                    onStreamError(new Error('Liveview: HTTP headers too large'));
                    return;
                }
                const hEnd = findHttpHeaderEnd(headerBuf);
                if (hEnd < 0) {
                    return;
                }

                const headStr = headerBuf.subarray(0, hEnd).toString('latin1');
                const statusLine0 = headStr.split('\r\n')[0] ?? '';
                const statusMatch = statusLine0.match(/\s(\d{3})\b/);
                const statusCode =
                    statusMatch?.[1] != null ? parseInt(statusMatch[1], 10) : 0;
                if (statusCode < 200 || statusCode >= 300) {
                    socket.destroy();
                    onStreamError(new Error(`Liveview: HTTP ${statusCode}`));
                    return;
                }

                headersDone = true;
                incoming = parseSonyLiveviewBuffer(headerBuf.subarray(hEnd), onJpeg);
                headerBuf = Buffer.alloc(0);
                return;
            }

            incoming = parseSonyLiveviewBuffer(Buffer.concat([incoming, chunk]), onJpeg);
        } catch (e) {
            onStreamError(e instanceof Error ? e : new Error(String(e)));
        }
    });

    socket.on('error', onStreamError);
    socket.on('close', onStreamClosed);
    return socket;
}

interface RpcRequest {
    id: number;
    version: string;
    method?: string;
    params?: any[];
}

interface SonyCameraParams {
    [key: string]: {
        current: any;
        available: any[];
    };
}

class SonyCamera extends EventEmitter implements CameraStrategy {
    readonly type: CameraType = 'sony_wifi';
    url: string;
    port: number;
    path: string;
    method: string;
    rpcReq: RpcRequest;
    params: SonyCameraParams;
    status: string;
    state: CameraState;
    connected: boolean;
    ready: boolean;
    availableApiList: string[];
    photosRemaining?: number;
    connecting?: boolean;
    eventPending?: boolean;
    /** Raw TCP/TLS stream — see `connectSonyLiveviewSocket` (avoids HTTP chunked decode on Sony binary). */
    liveviewSocket?: Socket;
    liveViewSubscribers: Set<LiveViewFrameHandler>;
    logger: TaggedLogger;

    constructor(url?: string, port?: number, path?: string) {
        super();
        this.url = url || '192.168.122.1';
        this.port = port || 8080;
        this.path = path || '/sony/camera';
        this.method = "old";
        this.logger = logger;

        this.rpcReq = {
            id: 1,
            version: '1.0'
        };

        this.params = {};
        this.status = "UNKNOWN";
        this.state = 'disconnected';

        this.connected = false;
        this.ready = false;
        this.availableApiList = [];
        this.liveViewSubscribers = new Set();
    }

    getState(): CameraState {
        return this.state;
    }

    subscribeLiveView(handler: LiveViewFrameHandler): () => void {
        this.liveViewSubscribers.add(handler);
        return () => {
            this.liveViewSubscribers.delete(handler);
        };
    }

    private publishLiveViewFrame(image: Buffer): void {
        const frame = {
            mimeType: 'image/jpeg',
            data: image,
            timestamp: Date.now()
        };
        for (const subscriber of this.liveViewSubscribers) {
            subscriber(frame);
        }
    }

    call(method: string, params?: any[], callback?: (err: any, result?: any) => void): void {
        const self = this;
        this.rpcReq.method = method;
        this.rpcReq.params = params || [];
        const postData = JSON.stringify(this.rpcReq);

        let timeoutHandle: NodeJS.Timeout | null = null;

        const req = request({
            method: 'POST',
            hostname: this.url,
            port: this.port,
            path: this.path,
            timeout: 2000,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, function (res) {
            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', function(chunk: string) {
                rawData += chunk;
            });
            let parsedData = null;
            res.on('end', function() {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                try {
                    parsedData = JSON.parse(rawData);
                    const result = parsedData ? parsedData.result : null;
                    const error = parsedData ? parsedData.error : null;
                    if(error) {
                        if(error.length > 0 && error[0] == 1 && method == 'getEvent') {
                            setTimeout(function() {
                                self.call(method, params, callback);
                            });
                            return;
                        }
                        self.logger.warn("SonyWifi: error during request", method, error);
                    }
                    callback && callback(error, result);
                } catch (e) {
                    self.logger.error((e as Error).message);
                    callback && callback(e);
                }
            });
        });

        timeoutHandle = setTimeout(function() {
            req.destroy(new Error('RPC request timeout'));
            self.logger.warn("SonyWifi: network appears to be disconnected (timeout for " + method + ")");
            self.state = 'disconnected';
            self.emit('disconnected');
        }, 60000);

        req.write(postData);
        req.end();

        req.on('error', function(err: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if(err && err.code) {
                self.logger.warn("SonyWifi: network appears to be disconnected (error for " + method + ": " + err + ", err.code:", err.code, ")");
                if(method == "getApplicationInfo" && err.code == 'ECONNREFUSED' && self.method == 'old') {
                    self.logger.warn("SonyWifi: ECONNREFUSED when connecting to port " + self.port + ", trying new method...");
                    self.method = 'new';
                    self.port = 10000;
                    setTimeout(function() {
                        self.call(method, params, callback);
                    });
                    return;
                }
                self.state = 'disconnected';
                self.emit('disconnected');
            }
            callback && callback(err);
        });
    }

    _processEvents(waitForChange?: boolean, callback?: (err: any) => void): void {
        const self = this;
        this.eventPending = true;
        this.call('getEvent', [waitForChange || false], function (err: any, results: any[]) {
            self.eventPending = false;
            if (!err && results) {
                for(let i = 0; i < results.length; i++) {
                    let item = results[i];
                    if(item instanceof Array) {
                        if(item.length > 0) {
                            item = {
                                type: item[0].type,
                                items: item
                            };
                        } else {
                            continue;
                        }
                    }
                    if(!item) {
                        continue;
                    } else if(item.type && item.type == 'cameraStatus') {
                        const nextStatus = item.cameraStatus;
                        const previousStatus = self.status;
                        self.status = nextStatus;
                        if(self.status == "NotReady") {
                            self.connected = false;
                            self.state = 'disconnected';
                            self.logger.warn("SonyWifi: disconnected, trying to reconnect");
                            setTimeout(function(){self.connect(); }, 2500);
                        }
                        if(self.status == "IDLE") {
                            self.ready = true;
                            self.state = 'ready';
                        } else {
                            self.ready = false;
                            self.state = self.connected ? 'busy' : 'disconnected';
                        }
                        if(previousStatus != nextStatus) {
                            self.emit('status', nextStatus);
                            self.logger.info("SonyWifi: status", self.status);
                        }
                    } else if(item.type && item.type == 'storageInformation') {
                        for(let j = 0; j < item.items.length; j++) {
                            if(item.items[j].recordTarget) {
                                self.photosRemaining = item.items[j].numberOfRecordableImages || 0;
                            }
                        }
                    } else if(item.type && item.type == 'availableApiList') {
                        self.availableApiList = item.names || [];
                    } else if(item.type && item[item.type + 'Candidates']) {
                        const type = item.type;
                        const existingParam = type ? self.params[type] : undefined;
                        const oldVal = existingParam ? existingParam.current : null;
                        self.params[type] = {
                            current: item['current' + item.type.charAt(0).toUpperCase() + item.type.slice(1)],
                            available: item[item.type + 'Candidates'],
                        };
                        const updatedParam = self.params[type];
                        if(oldVal !== updatedParam.current) {
                            self.logger.info("SonyWifi: " + item.type + " = " + updatedParam.current + "(+" + (updatedParam.available ? updatedParam.available.length : "NULL")  + " available)");
                            self.emit("update", item.type, updatedParam);
                        }
                    }
                }
            }

            if (callback) {
                callback(err);
            }
        });
    }

    connect(): Promise<void> {
        const self = this;
        if(this.connecting) return Promise.reject(new Error('Already trying to connect'));
        this.connecting = true;
        this.state = 'connecting';
        this.logger.info("SonyWifi: connecting...");

        return new Promise((resolve, reject) => {
            this.getAppVersion(function(err: any, version?: string) {
                if(!err && version) {
                    self.logger.info("SonyWifi: app version", version);
                    if(semver.gte(version, minVersionRequired)) {
                        const connected = function() {
                            self.connected = true;
                            self.state = 'busy';
                            const _checkEvents = function(eventError?: any) {
                                if(!eventError) {
                                    if(self.connected) {
                                        self._processEvents(true, _checkEvents);
                                    } else {
                                        self.logger.warn("SonyWifi: disconnected, stopping event poll");
                                    }
                                } else {
                                    setTimeout(_checkEvents, 5000);
                                }
                            };
                            self._processEvents(false, function(eventError: any){
                                self.connecting = false;
                                if(eventError) {
                                    self.state = 'error';
                                    reject(eventError);
                                    return;
                                }
                                _checkEvents();
                                self.emit('connect');
                                resolve();
                            });
                        };
                        if(self.method == "old") {
                            self.call('startRecMode', undefined, function(recModeError: any) {
                                if(!recModeError && !self.connected) {
                                    connected();
                                } else {
                                    self.connecting = false;
                                    self.state = 'error';
                                    reject(recModeError);
                                }
                            });
                        } else {
                            connected();
                        }
                    } else {
                        self.connecting = false;
                        self.state = 'error';
                        reject(
                            {
                                err: 'APPVERSION',
                                message:'Could not connect to camera -- remote control application must be updated (currently installed: ' + version + ', should be ' + minVersionRequired + ' or newer)'
                            }
                        );
                    }
                } else {
                    self.connecting = false;
                    self.state = 'error';
                    reject(err);
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        await this.stopLiveView();
        await new Promise<void>((resolve, reject) => {
            this.call('stopRecMode', undefined, (err: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                this.connected = false;
                this.ready = false;
                this.state = 'disconnected';
                resolve();
            });
        });
    }

    startLiveView(): Promise<void> {
        const self = this;
        if (this.liveviewSocket) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.call('startLiveview', undefined, function (err: any, output: string[]) {
                if (err || !output || !output[0]) {
                    reject(err ?? new Error('No liveview url returned by camera'));
                    return;
                }

                const liveviewUrl = new URL(output[0]);

                const sock = connectSonyLiveviewSocket(
                    liveviewUrl,
                    (jpeg) => {
                        self.emit('liveviewJpeg', jpeg);
                        self.publishLiveViewFrame(jpeg);
                    },
                    (e: Error) => {
                        self.logger.error('Liveview stream error', e);
                        self.liveviewSocket = undefined;
                    },
                    () => {
                        self.logger.info('Liveview stream closed');
                        self.liveviewSocket = undefined;
                    },
                );

                self.liveviewSocket = sock;
                resolve();
            });
        });
    }

    async stopLiveView(): Promise<void> {
        const active = this.liveviewSocket;
        this.liveviewSocket = undefined;
        if (active) {
            active.destroy();
        }

        await new Promise<void>((resolve, reject) => {
            this.call('stopLiveview', undefined, (err: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    async capture(): Promise<CaptureResult> {
        const self = this;

        if (this.liveviewSocket) {
            try {
                await this.stopLiveView();
            } catch (e) {
                this.logger.warn('SonyWifi: stopLiveView before capture failed', e);
            }
        }

        /** getEvent updates `status` asynchronously after liveview stops — wait before actTakePicture. */
        for (let i = 0; i < 50 && this.status !== 'IDLE'; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (this.status !== 'IDLE') {
            this.logger.warn("SonyWifi: camera busy, capture not available.  Status:", this.status);
            throw new Error('camera not ready');
        }

        this.ready = false;
        this.state = 'busy';

        const output = await new Promise<any>((resolve, reject) => {
            const processCaptureResult = function(err: any, result: any) {
                if (err) {
                    if(Array.isArray(err) && err.length > 0 && err[0] == 40403) {
                        self.call('awaitTakePicture', undefined, processCaptureResult);
                    } else {
                        reject(err);
                    }
                    return;
                }
                resolve(result);
            };

            self.call('actTakePicture', undefined, processCaptureResult);
        });

        const url = output[0][0];
        const parts = url.split('?')[0].split('/');
        const photoName = parts[parts.length - 1];
        this.logger.info("SonyWifi: Capture complete:", photoName);

        let data: Buffer;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`Request Failed. Status Code: ${res.status}`);
            }
            const ab = await res.arrayBuffer();
            data = Buffer.from(ab);
            this.logger.info('SonyWifi: Retrieved preview image:', photoName);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`SonyWifi: failed to download capture: ${message}`);
        }

        this.state = 'ready';
        this.ready = true;

        return {
            id: photoName,
            mimeType: 'image/jpeg',
            data
        };
    }

    getAppVersion(callback?: (err: any, version?: string) => void): void {
        this.call('getApplicationInfo', undefined, function(err: any, res: any[]) {
            let version: string | undefined;
            if(!err && res && res.length > 1) {
                version = res[1];
            }
            callback && callback(err, version);
        });
    }
}

export default SonyCamera;