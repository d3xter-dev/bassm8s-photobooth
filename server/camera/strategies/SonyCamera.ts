import { CameraType } from '../types';
import { URL } from 'url';
import { request, get, type ClientRequest } from 'http';
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
    liveviewReq?: ClientRequest;
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
        if (this.liveviewReq) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.call('startLiveview', undefined, function (err: any, output: string[]) {
                if (err || !output || !output[0]) {
                    reject(err ?? new Error('No liveview url returned by camera'));
                    return;
                }

                const liveviewUrl = new URL(output[0]);

                const COMMON_HEADER_SIZE = 8;
                const PAYLOAD_HEADER_SIZE = 128;
                const JPEG_SIZE_POSITION = 4;
                const PADDING_SIZE_POSITION = 7;

                let jpegSize = 0;
                let paddingSize = 0;
                let bufferIndex = 0;

                const liveviewReq = request(liveviewUrl, function (liveviewRes) {
                    let imageBuffer = Buffer.alloc(0);
                    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

                    liveviewRes.on('data', function (chunk: Buffer) {
                        if (jpegSize === 0) {
                            buffer = Buffer.concat([buffer, chunk]);

                            if (buffer.length >= (COMMON_HEADER_SIZE + PAYLOAD_HEADER_SIZE)) {
                                jpegSize =
                                    buffer.readUInt8(COMMON_HEADER_SIZE + JPEG_SIZE_POSITION) * 65536 +
                                    buffer.readUInt16BE(COMMON_HEADER_SIZE + JPEG_SIZE_POSITION + 1);

                                imageBuffer = Buffer.alloc(jpegSize);

                                paddingSize = buffer.readUInt8(COMMON_HEADER_SIZE + PADDING_SIZE_POSITION);

                                buffer = buffer.subarray(COMMON_HEADER_SIZE + PAYLOAD_HEADER_SIZE);
                                if (buffer.length > 0) {
                                    const copyLength = Math.min(buffer.length, jpegSize);
                                    buffer.copy(imageBuffer, bufferIndex, 0, copyLength);
                                    bufferIndex += copyLength;
                                    jpegSize -= copyLength;

                                    if (jpegSize === 0) {
                                        self.emit('liveviewJpeg', imageBuffer);
                                        self.publishLiveViewFrame(imageBuffer);
                                        buffer = buffer.subarray(copyLength + paddingSize);
                                        bufferIndex = 0;
                                    }
                                }
                            }
                        } else {
                            const copyLength = Math.min(chunk.length, jpegSize);
                            chunk.copy(imageBuffer, bufferIndex, 0, copyLength);
                            bufferIndex += copyLength;
                            jpegSize -= copyLength;

                            if (jpegSize === 0) {
                                self.emit('liveviewJpeg', imageBuffer);
                                self.publishLiveViewFrame(imageBuffer);
                                buffer = chunk.subarray(copyLength + paddingSize);
                                bufferIndex = 0;
                            }
                        }
                    });

                    liveviewRes.on('end', function () {
                        self.logger.info('Liveview stream ended');
                    });

                    liveviewRes.on('close', function () {
                        self.logger.info('Liveview stream closed');
                        self.liveviewReq = undefined;
                    });
                });

                liveviewReq.on('error', function(e: Error) {
                    self.logger.error('Liveview stream request error', e);
                    self.liveviewReq = undefined;
                });

                self.liveviewReq = liveviewReq;
                liveviewReq.end();
                resolve();
            });
        });
    }

    async stopLiveView(): Promise<void> {
        const activeReq = this.liveviewReq;
        this.liveviewReq = undefined;
        if (activeReq) {
            activeReq.destroy();
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
        if(this.status != "IDLE") {
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

        const data = await new Promise<Buffer>((resolve, reject) => {
            get(url, function(res) {
                const statusCode = res.statusCode;
                if (statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Request Failed. Status Code: ${statusCode}`));
                    return;
                }

                const rawData: Buffer[] = [];
                res.on('data', function(chunk: Buffer) {
                    rawData.push(chunk);
                });
                res.on('end', function() {
                    self.logger.info("SonyWifi: Retrieved preview image:", photoName);
                    resolve(Buffer.concat(rawData));
                });
            }).on('error', function(e: Error) {
                reject(e);
            });
        });

        this.state = 'ready';

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