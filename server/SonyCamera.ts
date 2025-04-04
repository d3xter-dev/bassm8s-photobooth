'use strict';

import { URL } from 'url';
import { request, get } from 'http';
import semver from 'semver';
import { EventEmitter } from 'events';
import {emit} from "nitropack/presets/_unenv/workerd/process";

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

class SonyCamera extends EventEmitter {
    url: string;
    port: number;
    path: string;
    method: string;
    rpcReq: RpcRequest;
    params: SonyCameraParams;
    status: string;
    connected: boolean;
    ready: boolean;
    availableApiList: string[];
    photosRemaining?: number;
    connecting?: boolean;
    eventPending?: boolean;

    constructor(url?: string, port?: number, path?: string) {
        super();
        this.url = url || '192.168.122.1';
        this.port = port || 8080;
        this.path = path || '/sony/camera';
        this.method = "old";

        this.rpcReq = {
            id: 1,
            version: '1.0'
        };

        this.params = {};
        this.status = "UNKNOWN";

        this.connected = false;
        this.ready = false;
        this.availableApiList = [];
    }

    show(): void {
        console.log(this.url + ':' + this.port + this.path);
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
                        console.log("SonyWifi: error during request", method, error);
                    }
                    callback && callback(error, result);
                } catch (e) {
                    console.log((e as Error).message);
                    callback && callback(e);
                }
            });
        });

        timeoutHandle = setTimeout(function() {
            req.abort();
            console.log("SonyWifi: network appears to be disconnected (timeout for " + method + ")");
            self.emit('disconnected');
        }, 60000);

        req.write(postData);
        req.end();

        req.on('error', function(err: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if(err && err.code) {
                console.log("SonyWifi: network appears to be disconnected (error for " + method + ": " + err + ", err.code:", err.code, ")");
                if(method == "getApplicationInfo" && err.code == 'ECONNREFUSED' && self.method == 'old') {
                    console.log("SonyWifi: ECONNREFUSED when connecting to port " + self.port + ", trying new method...");
                    self.method = 'new';
                    self.port = 10000;
                    setTimeout(function() {
                        self.call(method, params, callback);
                    });
                    return;
                }
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
                        self.status = item.cameraStatus;
                        if(self.status == "NotReady") {
                            self.connected = false;
                            console.log("SonyWifi: disconnected, trying to reconnect");
                            setTimeout(function(){self.connect(); }, 2500);
                        }
                        if(self.status == "IDLE") self.ready = true; else self.ready = false;
                        if(self.status != item.cameraStatus) {
                            self.emit('status', item.cameraStatus);
                            console.log("SonyWifi: status", self.status);
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
                        const oldVal = self.params[item.type] ? self.params[item.type].current : null;
                        self.params[item.type] = {
                            current: item['current' + item.type.charAt(0).toUpperCase() + item.type.slice(1)],
                            available: item[item.type + 'Candidates'],
                        };
                        if(oldVal !== self.params[item.type].current) {
                            console.log("SonyWifi: " + item.type + " = " + self.params[item.type].current + "(+" + (self.params[item.type].available ? self.params[item.type].available.length : "NULL")  + " available)");
                            self.emit("update", item.type, self.params[item.type]);
                        }
                    }
                }
            }

            if (callback) {
                callback(err);
            }
        });
    }

    connect(callback?: (err: any) => void): void {
        const self = this;
        if(this.connecting) return callback && callback('Already trying to connect');
        this.connecting = true;
        console.log("SonyWifi: connecting...");
        this.getAppVersion(function(err: any, version: string) {
            if(!err && version) {
                console.log("SonyWifi: app version", version);
                if(semver.gte(version, minVersionRequired)) {
                    const connected = function() {
                        self.connected = true;
                        const _checkEvents = function(err?: any) {
                            if(!err) {
                                if(self.connected) self._processEvents(true, _checkEvents); else console.log("SonyWifi: disconnected, stopping event poll");
                            } else {
                                setTimeout(_checkEvents, 5000);
                            }
                        };
                        self._processEvents(false, function(err: any){
                            self.connecting = false;
                            callback && callback(err);
                            _checkEvents();
                        });

                        self.emit('connect');
                    };
                    if(self.method == "old") {
                        self.call('startRecMode', null, function(err: any) {
                            if(!err && !self.connected) {
                                connected();
                            } else {
                                self.connecting = false;
                                callback && callback(err);
                            }
                        });
                    } else {
                        connected();
                    }
                } else {
                    callback && callback(
                        {
                            err: 'APPVERSION',
                            message:'Could not connect to camera -- remote control application must be updated (currently installed: ' + version + ', should be ' + minVersionRequired + ' or newer)'
                        }
                    );
                }
            } else {
                self.connecting = false;
                callback && callback(err);
            }
        });
    }

    disconnect(callback?: (err: any) => void): void {
        this.call('stopRecMode', null, function(err: any) {
            if(!err) {
                this.connected = false;
            }
            callback && callback(err);
        });
    }

    startViewfinder(): void {
        const self = this;
        this.call('startLiveview', null, function (err: any, output: string[]) {
            if (err || !output || !output[0]) return;
            
            const liveviewUrl = new URL(output[0]);

            const COMMON_HEADER_SIZE = 8;
            const PAYLOAD_HEADER_SIZE = 128;
            const JPEG_SIZE_POSITION = 4;
            const PADDING_SIZE_POSITION = 7;

            let jpegSize = 0;
            let paddingSize = 0;
            let bufferIndex = 0;

            const liveviewReq = request(liveviewUrl, function (liveviewRes) {
                let imageBuffer: Buffer;
                let buffer = Buffer.alloc ? Buffer.alloc(0) : Buffer.from('');

                liveviewRes.on('data', function (chunk: Buffer) {
                    if (jpegSize === 0) {
                        buffer = Buffer.concat([buffer, chunk]);

                        if (buffer.length >= (COMMON_HEADER_SIZE + PAYLOAD_HEADER_SIZE)) {
                            jpegSize =
                                buffer.readUInt8(COMMON_HEADER_SIZE + JPEG_SIZE_POSITION) * 65536 +
                                buffer.readUInt16BE(COMMON_HEADER_SIZE + JPEG_SIZE_POSITION + 1);

                            imageBuffer = Buffer.alloc ? Buffer.alloc(jpegSize) : Buffer.from('');

                            paddingSize = buffer.readUInt8(COMMON_HEADER_SIZE + PADDING_SIZE_POSITION);

                            buffer = buffer.subarray(COMMON_HEADER_SIZE + PAYLOAD_HEADER_SIZE);
                            if (buffer.length > 0) {
                                const copyLength = Math.min(buffer.length, jpegSize);
                                buffer.copy(imageBuffer, bufferIndex, 0, copyLength);
                                bufferIndex += copyLength;
                                jpegSize -= copyLength;
                                
                                if (jpegSize === 0) {
                                    self.emit('liveviewJpeg', imageBuffer);
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
                            buffer = chunk.subarray(copyLength + paddingSize);
                            bufferIndex = 0;
                        }
                    }
                });

                liveviewRes.on('end', function () {
                    console.log('End');
                });

                liveviewRes.on('close', function () {
                    console.log('Close');
                });
            });

            liveviewReq.on('error', function(e: Error) {
                console.error('Error: ', e);
            });

            liveviewReq.end();
        });
    }

    stopViewfinder(callback?: (err: any, result?: any) => void): void {
        this.call('stopLiveview', null, callback);
    }

    capture(enableDoubleCallback: boolean | ((err: any, photoName?: string, data?: Buffer) => void), 
            callback?: (err: any, photoName?: string, data?: Buffer) => void): void {
        const self = this;

        if(!callback && typeof enableDoubleCallback === "function") {
            callback = enableDoubleCallback as (err: any, photoName?: string, data?: Buffer) => void;
            enableDoubleCallback = false;
        }

        if(this.status != "IDLE") {
            console.log("SonyWifi: camera busy, capture not available.  Status:", this.status);
            return callback && callback('camera not ready');
        }

        this.ready = false;

        const processCaptureResult = function(err: any, output: any) {
            if (err) {
                if(Array.isArray(err) && err.length > 0 && err[0] == 40403) { // capture still in progress
                    self.call('awaitTakePicture', null, processCaptureResult);
                } else {
                    callback && callback(err);
                }
                return;
            }

            const url = output[0][0];

            const parts = url.split('?')[0].split('/');
            const photoName = parts[parts.length - 1];
            console.log("SonyWifi: Capture complete:", photoName);

            if(enableDoubleCallback && callback) callback(err, photoName);

            get(url, function(res) {
                const statusCode = res.statusCode;
                const contentType = res.headers['content-type'];

                let error;
                if (statusCode !== 200) {
                    error = new Error(`Request Failed. Status Code: ${statusCode}`);
                }
                if (error) {
                    res.resume();
                    callback && callback(err);
                    return;
                }

                const rawData: Buffer[] = [];
                res.on('data', function(chunk: Buffer) {
                    rawData.push(chunk);
                });
                res.on('end', function() {
                    console.log("SonyWifi: Retrieved preview image:", photoName);
                    callback && callback(null, photoName, Buffer.concat(rawData));
                });
            }).on('error', function(e: Error) {
                callback && callback(e);
            });
        };

        self.call('actTakePicture', null, processCaptureResult);
    }

    startBulbShooting(callback?: (err: any) => void): void {
        console.log('startBulbShooting');
        this.call('startBulbShooting', null, callback);
    }

    stopBulbShooting(callback?: (err: any) => void): void {
        console.log('stopBulbShooting');
        this.call('stopBulbShooting', null, callback);
    }

    zoomIn(callback?: (err: any) => void): void {
        this.call('actZoom', ['in', 'start'], callback);
    }

    zoomOut(callback?: (err: any) => void): void {
        this.call('actZoom', ['out', 'start'], callback);
    }

    getAppVersion(callback?: (err: any, version?: string) => void): void {
        this.call('getApplicationInfo', null, function(err: any, res: any[]) {
            let version = null;
            if(!err && res && res.length > 1) {
                version = res[1];
            }
            callback && callback(err, version);
        });
    }

    set(param: string, value: any, callback?: (err: any) => void): void {
        if(this.status != "IDLE") return callback && callback('camera not ready');

        const action = 'set' + param.charAt(0).toUpperCase() + param.slice(1);
        if(this.availableApiList.indexOf(action) === -1 || !this.params[param]) {
            return callback && callback("param not available");
        }
        if(this.params[param].available.indexOf(value) === -1) {
            return callback && callback("value not available");
        }
        this.call(action, [value], callback);
    }
}

export default SonyCamera;