/// <reference types="bun" />
import { JSCallback, ptr } from 'bun:ffi';
import { existsSync, statfsSync } from 'node:fs';
import { platform } from 'node:process';
import {
  bufferFromNativePtr,
  loadEdsBindings,
  readU32,
  readU64LE,
  readU64Ptr,
  writeU32,
  type EdsBindings
} from './ffi';
import {
  EDS_ERR_DEVICE_BUSY,
  EDS_ERR_OK,
  EDS_ERR_OBJECT_NOTREADY,
  EDS_ERR_INVALID_PARAMETER,
  kEdsCameraCommand_PressShutterButton,
  kEdsCameraCommand_ShutterButton_Completely_NonAF,
  kEdsCameraCommand_ShutterButton_OFF,
  kEdsCameraCommand_TakePicture,
  kEdsEvfDepthOfFieldPreview_Off,
  kEdsEvfMode_Evf,
  kEdsEvfMode_Off,
  kEdsEvfOutputDevice_PC,
  kEdsEvfOutputDevice_PC_Small,
  kEdsEvfOutputDevice_TFT,
  kEdsObjectEvent_All,
  kEdsObjectEvent_DirItemRequestTransfer,
  kEdsPropertyEvent_All,
  kEdsPropID_Evf_DepthOfFieldPreview,
  kEdsPropID_Evf_Mode,
  kEdsPropID_Evf_OutputDevice,
  kEdsPropID_SaveTo,
  kEdsSaveTo_Host,
  kEdsStateEvent_All,
  kEdsStateEvent_Shutdown
} from './constants';
import { resolveEsdkLibPath } from './path';
import type { EventBus } from '../core/event-bus';
import type { BridgeMetrics } from '../core/metrics';

type CaptureWaiter = {
  resolve: (buf: Buffer) => void;
  reject: (error: Error) => void;
};

const DEFAULT_MEM_STREAM = 4 * 1024 * 1024;
const JPEG_EOI_MARKER = Buffer.from([0xff, 0xd9]);
const HOST_BYTES_PER_SECTOR = 0x1000;
const FALLBACK_FREE_BYTES = 1024 * 1024 * 1024 * 1024;

function ptrOut(): Uint8Array {
  return new Uint8Array(8);
}

function readRef(buf: Uint8Array): number {
  return readU64Ptr(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EdsdkSession {
  private lib: ReturnType<typeof loadEdsBindings> | null = null;
  private eds: EdsBindings['symbols'] | null = null;

  private cameraListRef = 0;
  private cameraRef = 0;
  private streamRef = 0;
  private evfRef = 0;

  private objectHandler: InstanceType<typeof JSCallback> | null = null;
  private propertyHandler: InstanceType<typeof JSCallback> | null = null;
  private stateHandler: InstanceType<typeof JSCallback> | null = null;

  private captureWaiter: CaptureWaiter | null = null;
  private capacityNotifyReset = true;
  private lastEvfErrLogMs = 0;
  private evfConsecutiveFails = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly metrics: BridgeMetrics
  ) {}

  get isConnected(): boolean {
    return this.cameraRef !== 0 && !!this.eds;
  }

  get hasEds(): boolean {
    return !!this.eds;
  }

  get hasLiveView(): boolean {
    return this.evfRef !== 0 && this.streamRef !== 0;
  }

  private ensureEds(): EdsBindings['symbols'] {
    if (!this.eds) throw new Error('EDSDK not loaded');
    return this.eds;
  }

  private getHostFreeBytes(): number {
    const root = process.env.CANON_HOST_DISK_PATH ?? process.cwd();
    try {
      const s = statfsSync(root);
      const bsize = Number(s.bsize);
      if (!Number.isFinite(bsize) || bsize <= 0) return 0;
      const rawBavail = (s as { bavail?: bigint | number }).bavail;
      const rawBfree = (s as { bfree?: bigint | number }).bfree;
      const bavail = rawBavail !== undefined ? Number(rawBavail) : NaN;
      const bfree = rawBfree !== undefined ? Number(rawBfree) : NaN;
      const blocks = Number.isFinite(bavail) && bavail >= 0 ? bavail : bfree;
      if (!Number.isFinite(blocks) || blocks < 0) return 0;
      const free = blocks * bsize;
      if (!Number.isFinite(free) || free <= 0) return 0;
      return Math.min(free, Number.MAX_SAFE_INTEGER);
    } catch {
      return FALLBACK_FREE_BYTES;
    }
  }

  private trimJpegBufferToEoi(buf: Buffer): Buffer {
    if (buf.length < 4) return buf;
    const tail = Math.min(buf.length, Math.max(32 * 1024, Number(process.env.CANON_LIVEVIEW_TRIM_TAIL_BYTES || 128 * 1024)));
    const start = buf.length - tail;
    for (let i = buf.length - 2; i >= start; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
        return buf.subarray(0, i + 2);
      }
    }
    const eoi = buf.lastIndexOf(JPEG_EOI_MARKER);
    return eoi < 1 ? buf : buf.subarray(0, eoi + 2);
  }

  private trimJpegFromNativePtr(nativePtr: number, len: number): Buffer {
    if (!nativePtr || len <= 0) return Buffer.alloc(0);
    const tailLen = Math.min(len, Math.max(32 * 1024, Number(process.env.CANON_LIVEVIEW_TRIM_TAIL_BYTES || 128 * 1024)));
    if (tailLen < 4) return Buffer.alloc(0);
    if (len <= tailLen) {
      return this.trimJpegBufferToEoi(bufferFromNativePtr(nativePtr, len));
    }
    const tailPtr = nativePtr + (len - tailLen);
    const tail = bufferFromNativePtr(tailPtr, tailLen);
    for (let i = tail.length - 2; i >= 0; i--) {
      if (tail[i] === 0xff && tail[i + 1] === 0xd9) {
        return bufferFromNativePtr(nativePtr, len - tailLen + i + 2);
      }
    }
    return this.trimJpegBufferToEoi(bufferFromNativePtr(nativePtr, len));
  }

  private async setU32PropDeviceBusyRetry(
    cam: number,
    propId: number,
    value: number,
    opts?: { maxAttempts?: number; delayMs?: number }
  ): Promise<void> {
    const maxAttempts = opts?.maxAttempts ?? 90;
    const delayMs = opts?.delayMs ?? 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const e = this.ensureEds();
      const v = new Uint8Array(4);
      writeU32(v, value);
      const err = e.EdsSetPropertyData(cam as never, propId >>> 0, 0, 4, ptr(v));
      if (err === EDS_ERR_OK) return;
      if (err !== EDS_ERR_DEVICE_BUSY) {
        throw new Error(`EdsSetPropertyData(${propId.toString(16)}) failed: 0x${err.toString(16)}`);
      }
      await sleep(delayMs);
    }
    throw new Error(`EdsSetPropertyData(${propId.toString(16)}) failed: DEVICE_BUSY`);
  }

  private async getU32PropDeviceBusyRetry(
    cam: number,
    propId: number,
    opts?: { maxAttempts?: number; delayMs?: number }
  ): Promise<number> {
    const maxAttempts = opts?.maxAttempts ?? 45;
    const delayMs = opts?.delayMs ?? 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const e = this.ensureEds();
      const v = new Uint8Array(4);
      const err = e.EdsGetPropertyData(cam as never, propId >>> 0, 0, 4, ptr(v));
      if (err === EDS_ERR_OK) return readU32(v);
      if (err !== EDS_ERR_DEVICE_BUSY) {
        throw new Error(`EdsGetPropertyData(${propId.toString(16)}) failed: 0x${err.toString(16)}`);
      }
      await sleep(delayMs);
    }
    throw new Error(`EdsGetPropertyData(${propId.toString(16)}) failed: DEVICE_BUSY`);
  }

  /** Drain the SDK command queue so property/state handlers run after EVF changes. */
  private pumpEdsEvents(rounds = 48): void {
    const e = this.ensureEds();
    for (let i = 0; i < rounds; i++) {
      try {
        e.EdsGetEvent();
      } catch {
        /* ignore */
      }
    }
  }

  /** Wait until `EdsDownloadEvfImage` yields a JPEG (or timeout). Per EDSDK, retry OBJECT_NOTREADY. */
  private async waitForFirstEvfFrame(maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const r = this.downloadLiveViewFrame();
      if (r.fatal) throw new Error(r.fatal);
      if (r.frame && r.frame.length > 0) return true;
      await sleep(12);
    }
    return false;
  }

  private edsSetHostCapacityRaw(cam: number, opts?: { forceReset?: boolean }): number {
    const e = this.ensureEds();
    if (opts?.forceReset) this.capacityNotifyReset = true;
    const freeBytes = this.getHostFreeBytes();
    let clusters = Math.floor(freeBytes / HOST_BYTES_PER_SECTOR);
    if (freeBytes > 0 && clusters === 0) clusters = 1;
    if (clusters > 0x7fffffff) clusters = 0x7fffffff;
    const reset = this.capacityNotifyReset ? 1 : 0;
    this.capacityNotifyReset = false;
    const cap = new Uint8Array(12);
    writeU32(cap.subarray(0, 4), clusters >>> 0);
    writeU32(cap.subarray(4, 8), HOST_BYTES_PER_SECTOR);
    writeU32(cap.subarray(8, 12), reset);
    return e.EdsSetCapacity(cam as never, ptr(cap));
  }

  private async edsSetHostCapacityWithBusyRetry(cam: number, maxAttempts = 35, opts?: { forceReset?: boolean }): Promise<number> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const err = this.edsSetHostCapacityRaw(cam, opts);
      if (err === EDS_ERR_OK) return err;
      if (err !== EDS_ERR_DEVICE_BUSY) return err;
      await sleep(10);
    }
    return EDS_ERR_DEVICE_BUSY;
  }

  private async setEdsHostCapacityOrThrow(cam: number): Promise<void> {
    const err = await this.edsSetHostCapacityWithBusyRetry(cam);
    if (err !== EDS_ERR_OK) throw new Error(`EdsSetCapacity: 0x${err.toString(16)}`);
  }

  private async takePictureWithBusyRetry(cam: number, maxAttempts = 45): Promise<number> {
    const e = this.ensureEds();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const err = e.EdsSendCommand(cam as never, kEdsCameraCommand_TakePicture, 0);
      if (err === EDS_ERR_OK) return err;
      if (err !== EDS_ERR_DEVICE_BUSY) return err;
      await sleep(12);
    }
    return EDS_ERR_DEVICE_BUSY;
  }

  private discardDirItemSync(dirItem: number): void {
    const e = this.ensureEds();
    try {
      e.EdsDownloadCancel(dirItem as never);
    } catch {
      /* ignore */
    }
    try {
      e.EdsRelease(dirItem as never);
    } catch {
      /* ignore */
    }
  }

  private async downloadDirItem(dirItem: number): Promise<Buffer> {
    const e = this.ensureEds();
    try {
      const info = new Uint8Array(512);
      let err = e.EdsGetDirectoryItemInfo(dirItem as never, ptr(info));
      if (err !== EDS_ERR_OK) throw new Error(`EdsGetDirectoryItemInfo: 0x${err.toString(16)}`);
      const size64 = readU64LE(info, 0);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('EdsDirectoryItemInfo: file size too large');
      const fileSize = Number(size64);

      const outStream = ptrOut();
      err = e.EdsCreateMemoryStream(Math.max(fileSize, 1024 * 1024), ptr(outStream));
      if (err !== EDS_ERR_OK) throw new Error(`EdsCreateMemoryStream: 0x${err.toString(16)}`);
      const dlStream = readRef(outStream);
      const chunk = 512 * 1024;
      let offset = 0;
      while (offset < fileSize) {
        const block = Math.min(chunk, fileSize - offset);
        err = e.EdsDownload(dirItem as never, block >>> 0, dlStream as never);
        if (err !== EDS_ERR_OK) throw new Error(`EdsDownload: 0x${err.toString(16)}`);
        offset += block;
      }
      err = e.EdsDownloadComplete(dirItem as never);
      if (err !== EDS_ERR_OK) throw new Error(`EdsDownloadComplete: 0x${err.toString(16)}`);

      const lenBuf = new Uint8Array(4);
      err = e.EdsGetLength(dlStream as never, ptr(lenBuf));
      if (err !== EDS_ERR_OK) throw new Error(`EdsGetLength: 0x${err.toString(16)}`);
      const len = readU32(lenBuf);

      const ptrBuf = new Uint8Array(8);
      err = e.EdsGetPointer(dlStream as never, ptr(ptrBuf));
      if (err !== EDS_ERR_OK) throw new Error(`EdsGetPointer: 0x${err.toString(16)}`);
      const p = readU64Ptr(ptrBuf);
      const buf = bufferFromNativePtr(p, len);
      e.EdsRelease(dlStream as never);
      try {
        await this.edsSetHostCapacityWithBusyRetry(this.cameraRef);
      } catch {
        /* ignore */
      }
      return buf;
    } catch (error) {
      try {
        e.EdsDownloadCancel(dirItem as never);
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      try {
        e.EdsRelease(dirItem as never);
      } catch {
        /* ignore */
      }
    }
  }

  private installCallbacks(): void {
    const e = this.ensureEds();
    this.objectHandler = new JSCallback((event, inRef) => {
      try {
        const ev = event >>> 0;
        if (ev === kEdsObjectEvent_DirItemRequestTransfer && inRef) {
          const dirItem = inRef as number;
          const waiter = this.captureWaiter;
          if (!waiter) {
            this.discardDirItemSync(dirItem);
          } else {
            this.captureWaiter = null;
            void this.downloadDirItem(dirItem).then(waiter.resolve, (err) => {
              waiter.reject(err instanceof Error ? err : new Error(String(err)));
            });
          }
        }
      } catch {
        /* ignore */
      }
      return EDS_ERR_OK;
    }, { returns: 'u32', args: ['u32', 'ptr', 'ptr'], threadsafe: true });

    this.propertyHandler = new JSCallback((event, propertyId) => {
      this.bus.emit('camera.property-event', {
        event: event >>> 0,
        propertyId: (propertyId as number) >>> 0,
        at: Date.now()
      });
      return EDS_ERR_OK;
    }, { returns: 'u32', args: ['u32', 'u32', 'ptr'], threadsafe: true });

    this.stateHandler = new JSCallback((event, payload) => {
      const eventCode = event >>> 0;
      this.bus.emit('camera.state-event', {
        event: eventCode,
        payload: (payload as number) >>> 0,
        at: Date.now()
      });
      if (eventCode === kEdsStateEvent_Shutdown) {
        this.bus.emit('camera.disconnected', { reason: 'state_shutdown', at: Date.now() });
      }
      return EDS_ERR_OK;
    }, { returns: 'u32', args: ['u32', 'u32', 'ptr'], threadsafe: true });

    let err = e.EdsSetObjectEventHandler(this.cameraRef as never, kEdsObjectEvent_All, this.objectHandler.ptr, 0 as never);
    if (err !== EDS_ERR_OK) throw new Error(`EdsSetObjectEventHandler: 0x${err.toString(16)}`);
    err = e.EdsSetPropertyEventHandler(this.cameraRef as never, kEdsPropertyEvent_All, this.propertyHandler.ptr, 0 as never);
    if (err !== EDS_ERR_OK) throw new Error(`EdsSetPropertyEventHandler: 0x${err.toString(16)}`);
    err = e.EdsSetCameraStateEventHandler(this.cameraRef as never, kEdsStateEvent_All, this.stateHandler.ptr, 0 as never);
    if (err !== EDS_ERR_OK) throw new Error(`EdsSetCameraStateEventHandler: 0x${err.toString(16)}`);
  }

  async connect(opts: { cameraIndex: number; edsdkMacosDylibPath?: string; vendorRoot?: string }): Promise<void> {
    await this.disconnect('reconnect');
    this.capacityNotifyReset = true;
    const resolved = resolveEsdkLibPath({
      macosDylibPath: opts.edsdkMacosDylibPath,
      vendorRoot: opts.vendorRoot
    });
    if (!existsSync(resolved.primary)) throw new Error(resolved.error ?? `EDSDK library not found: ${resolved.primary}`);
    if (platform === 'darwin' && resolved.extraPaths.length > 0) {
      process.env.DYLD_LIBRARY_PATH = [resolved.extraPaths[0], process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    this.lib = loadEdsBindings(resolved.primary);
    this.eds = this.lib.symbols;
    const e = this.ensureEds();
    let err = e.EdsInitializeSDK();
    if (err !== EDS_ERR_OK) throw new Error(`EdsInitializeSDK: 0x${err.toString(16)}`);

    const outList = ptrOut();
    err = e.EdsGetCameraList(ptr(outList));
    if (err !== EDS_ERR_OK) throw new Error(`EdsGetCameraList: 0x${err.toString(16)}`);
    this.cameraListRef = readRef(outList);
    if (!this.cameraListRef) throw new Error('EdsGetCameraList returned null');

    const countBuf = new Uint8Array(4);
    err = e.EdsGetChildCount(this.cameraListRef as never, ptr(countBuf));
    if (err !== EDS_ERR_OK) throw new Error(`EdsGetChildCount: 0x${err.toString(16)}`);
    const count = readU32(countBuf);
    if (opts.cameraIndex < 0 || opts.cameraIndex >= count) {
      e.EdsRelease(this.cameraListRef as never);
      this.cameraListRef = 0;
      if (count === 0) {
        throw new Error(
          'No Canon camera detected — power on the body, check USB, wait for macOS/Windows to finish enumerating, and ensure no other app (EOS Utility, etc.) holds the camera'
        );
      }
      throw new Error(`Camera index ${opts.cameraIndex} out of range (found ${count})`);
    }

    const outCam = ptrOut();
    err = e.EdsGetChildAtIndex(this.cameraListRef as never, opts.cameraIndex, ptr(outCam));
    if (err !== EDS_ERR_OK) throw new Error(`EdsGetChildAtIndex: 0x${err.toString(16)}`);
    this.cameraRef = readRef(outCam);
    e.EdsRelease(this.cameraListRef as never);
    this.cameraListRef = 0;

    err = e.EdsOpenSession(this.cameraRef as never);
    if (err !== EDS_ERR_OK) throw new Error(`EdsOpenSession: 0x${err.toString(16)}`);

    this.installCallbacks();
    await this.setU32PropDeviceBusyRetry(this.cameraRef, kEdsPropID_SaveTo, kEdsSaveTo_Host, { maxAttempts: 120 });
    await this.setEdsHostCapacityOrThrow(this.cameraRef);
    this.bus.emit('camera.connected', { at: Date.now() });
  }

  getEvent(): void {
    if (!this.eds) return;
    const e = this.eds;
    const t0 = performance.now();
 
    try {
      e.EdsGetEvent();
    } catch {
    }
 
    const dt = performance.now() - t0;
    if (dt > 2) this.metrics.recordPumpBlock(dt);
  }

  private createEvfImageRefs(): void {
    const e = this.ensureEds();
    const outS = ptrOut();
    let err = e.EdsCreateMemoryStream(DEFAULT_MEM_STREAM, ptr(outS));
    if (err !== EDS_ERR_OK) throw new Error(`EdsCreateMemoryStream: 0x${err.toString(16)}`);
    this.streamRef = readRef(outS);
    const outEvf = ptrOut();
    err = e.EdsCreateEvfImageRef(this.streamRef as never, ptr(outEvf));
    if (err !== EDS_ERR_OK) throw new Error(`EdsCreateEvfImageRef: 0x${err.toString(16)}`);
    this.evfRef = readRef(outEvf);
  }

  private releaseEvfImageRefs(): void {
    const e = this.eds;
    if (this.evfRef && e) {
      try {
        e.EdsRelease(this.evfRef as never);
      } catch {
        /* ignore */
      }
      this.evfRef = 0;
    }
    if (this.streamRef && e) {
      try {
        e.EdsRelease(this.streamRef as never);
      } catch {
        /* ignore */
      }
      this.streamRef = 0;
    }
  }

  /**
   * After a shot we only pause host EVF (strip PC); we avoid toggling Evf_Mode Off so the TFT
   * does not flash menu→LV repeatedly. `resumeAfterCapture` re-arms PC + EVF refs without a full cold start.
   */
  async startLiveView(options?: { resumeAfterCapture?: boolean }): Promise<void> {
    if (!this.cameraRef) throw new Error('not connected');
    const resume = options?.resumeAfterCapture === true;
    if (!resume) {
      await this.stopLiveView();
    }
    this.evfConsecutiveFails = 0;
    const e = this.ensureEds();
    const cam = this.cameraRef;

    if (resume) {
      let device = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_OutputDevice);
      device |= kEdsEvfOutputDevice_PC
      await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_OutputDevice, device);
      this.pumpEdsEvents(32);
      let mode = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode);
      if (mode !== kEdsEvfMode_Evf) {
        await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode, kEdsEvfMode_Evf);
        this.pumpEdsEvents(32);
      }
      for (let i = 0; i < 15 && mode !== kEdsEvfMode_Evf; i++) {
        await sleep(10);
        this.pumpEdsEvents(16);
        mode = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode);
      }
      if (mode !== kEdsEvfMode_Evf) {
        throw new Error(`Evf_Mode readback expected ${kEdsEvfMode_Evf}, got ${mode}`);
      }
      this.createEvfImageRefs();
      const primed = await this.waitForFirstEvfFrame(2500);
      if (!primed) {
        this.releaseEvfImageRefs();
        throw new Error('EVF: no JPEG within 2500ms after resume — try full live view start');
      }
      this.bus.emit('liveview.started', { at: Date.now() });
      return;
    }

    try {
      await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_DepthOfFieldPreview, kEdsEvfDepthOfFieldPreview_Off, {
        maxAttempts: 20
      });
    } catch {
      /* unsupported on some bodies */
    }
    this.pumpEdsEvents(24);

    let modeLeadOk = false;
    try {
      await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode, kEdsEvfMode_Evf, { maxAttempts: 35 });
      modeLeadOk = true;
    } catch {
      /* many DSLRs reject Evf_Mode until OutputDevice routes to PC */
    }
    this.pumpEdsEvents(40);

    let device = kEdsEvfOutputDevice_PC;
    try {
      device = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_OutputDevice);
    } catch {
      /* ignore */
    }
    device |= kEdsEvfOutputDevice_PC | kEdsEvfOutputDevice_TFT;
    await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_OutputDevice, device);
    this.pumpEdsEvents(48);

    if (!modeLeadOk) {
      await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode, kEdsEvfMode_Evf);
      this.pumpEdsEvents(40);
    }

    let mode = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode);
    if (mode !== kEdsEvfMode_Evf) {
      await this.setU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode, kEdsEvfMode_Evf);
      this.pumpEdsEvents(48);
    }
    for (let i = 0; i < 30 && mode !== kEdsEvfMode_Evf; i++) {
      await sleep(12);
      this.pumpEdsEvents(24);
      mode = await this.getU32PropDeviceBusyRetry(cam, kEdsPropID_Evf_Mode);
    }
    if (mode !== kEdsEvfMode_Evf) {
      throw new Error(`Evf_Mode readback expected ${kEdsEvfMode_Evf}, got ${mode}`);
    }

    this.createEvfImageRefs();

    const primed = await this.waitForFirstEvfFrame(2000);
    if (!primed) {
      this.releaseEvfImageRefs();
      throw new Error(
        'EVF: no JPEG within 2000ms — leave playback/menus, close EOS Utility, and try again'
      );
    }

    this.bus.emit('liveview.started', { at: Date.now() });
  }

  async stopLiveView(reason = 'stopped'): Promise<void> {
    this.releaseEvfImageRefs();
    const isCapturePause = reason === 'capture' || reason === 'capture_shutter';
    if (this.cameraRef) {
      if (!isCapturePause) {
        try {
          await this.setU32PropDeviceBusyRetry(this.cameraRef, kEdsPropID_Evf_Mode, kEdsEvfMode_Off, { maxAttempts: 40 });
        } catch {
          /* ignore */
        }
      }
      try {
        let device = await this.getU32PropDeviceBusyRetry(this.cameraRef, kEdsPropID_Evf_OutputDevice);
        device &= ~kEdsEvfOutputDevice_PC;
        device &= ~kEdsEvfOutputDevice_PC_Small;
        await this.setU32PropDeviceBusyRetry(this.cameraRef, kEdsPropID_Evf_OutputDevice, device, { maxAttempts: 40 });
      } catch {
        /* ignore */
      }
    }
    this.bus.emit('liveview.stopped', { at: Date.now(), reason });
  }

  downloadLiveViewFrame(): { frame?: Buffer; transient?: boolean; fatal?: string } {
    if (!this.cameraRef || !this.evfRef || !this.streamRef) return {};
    const e = this.ensureEds();
    try {
      e.EdsGetEvent();
    } catch {
      /* ignore */
    }
    const err = e.EdsDownloadEvfImage(this.cameraRef as never, this.evfRef as never);
    if (err === EDS_ERR_OBJECT_NOTREADY || err === EDS_ERR_DEVICE_BUSY) {
      return { transient: true };
    }
    if (err !== EDS_ERR_OK) {
      this.evfConsecutiveFails++;
      const code = err >>> 0;
      const fatal = code === (EDS_ERR_INVALID_PARAMETER >>> 0) || this.evfConsecutiveFails >= 12;
      if (fatal) {
        this.evfConsecutiveFails = 0;
        return { fatal: `evf:0x${code.toString(16)}` };
      }
      const now = Date.now();
      if (now - this.lastEvfErrLogMs > 4000) {
        this.lastEvfErrLogMs = now;
        console.warn('[canon-bridge] EdsDownloadEvfImage error', code.toString(16));
      }
      return { transient: true };
    }
    this.evfConsecutiveFails = 0;
    const lenBuf = new Uint8Array(4);
    let e2 = e.EdsGetLength(this.streamRef as never, ptr(lenBuf));
    if (e2 !== EDS_ERR_OK) return {};
    const len = readU32(lenBuf);
    if (!len) return {};

    const ptrBuf = new Uint8Array(8);
    e2 = e.EdsGetPointer(this.streamRef as never, ptr(ptrBuf));
    if (e2 !== EDS_ERR_OK) return {};
    const p = readU64Ptr(ptrBuf);
    const jpeg = this.trimJpegFromNativePtr(p, len);
    if (!jpeg.length) return {};
    return { frame: jpeg };
  }

  async capture(): Promise<Buffer> {
    if (!this.cameraRef) throw new Error('not connected');
    const hadLiveView = this.hasLiveView;
    if (hadLiveView) {
      await this.stopLiveView('capture');
      try {
        await this.setU32PropDeviceBusyRetry(this.cameraRef, kEdsPropID_SaveTo, kEdsSaveTo_Host, { maxAttempts: 80 });
      } catch {
        /* ignore */
      }
    }

    return await new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.captureWaiter = null;
        reject(new Error('capture timeout'));
      }, 60_000);
      this.captureWaiter = {
        resolve: (buf) => {
          clearTimeout(timeout);
          resolve(buf);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
      void (async () => {
        const capErr = await this.edsSetHostCapacityWithBusyRetry(this.cameraRef, 35, { forceReset: true });
        if (capErr !== EDS_ERR_OK) {
          this.captureWaiter = null;
          reject(new Error(`EdsSetCapacity: 0x${capErr.toString(16)}`));
          return;
        }
        const err = await this.takePictureWithBusyRetry(this.cameraRef);
        if (err !== EDS_ERR_OK) {
          this.captureWaiter = null;
          reject(new Error(`TakePicture: 0x${err.toString(16)}`));
        }
      })().catch((error) => {
        this.captureWaiter = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    }).finally(async () => {
      if (hadLiveView) {
        try {
          await this.startLiveView({ resumeAfterCapture: true });
        } catch {
          try {
            await this.startLiveView();
          } catch (error) {
            console.warn('[canon-bridge] failed to resume liveview after capture', error);
          }
        }
      }
    });
  }

  async triggerShutter(): Promise<void> {
    if (!this.cameraRef) throw new Error('not connected');
    const hadLiveView = this.hasLiveView;
    if (hadLiveView) await this.stopLiveView('capture_shutter');
    try {
      const capErr = await this.edsSetHostCapacityWithBusyRetry(this.cameraRef, 35, { forceReset: true });
      if (capErr !== EDS_ERR_OK) throw new Error(`EdsSetCapacity: 0x${capErr.toString(16)}`);
      const e = this.ensureEds();
      let err = e.EdsSendCommand(this.cameraRef as never, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_Completely_NonAF);
      if (err !== EDS_ERR_OK) throw new Error(`PressShutter: 0x${err.toString(16)}`);
      err = e.EdsSendCommand(this.cameraRef as never, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_OFF);
      if (err !== EDS_ERR_OK) throw new Error(`ReleaseShutter: 0x${err.toString(16)}`);
    } finally {
      if (hadLiveView) {
        try {
          await this.startLiveView({ resumeAfterCapture: true });
        } catch {
          try {
            await this.startLiveView();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    this.captureWaiter?.reject(new Error('camera session ended'));
    this.captureWaiter = null;
    await this.stopLiveView(reason);

    if (this.objectHandler) {
      try {
        this.objectHandler.close();
      } catch {
        /* ignore */
      }
      this.objectHandler = null;
    }
    if (this.propertyHandler) {
      try {
        this.propertyHandler.close();
      } catch {
        /* ignore */
      }
      this.propertyHandler = null;
    }
    if (this.stateHandler) {
      try {
        this.stateHandler.close();
      } catch {
        /* ignore */
      }
      this.stateHandler = null;
    }

    const e = this.eds;
    if (e && this.cameraRef) {
      try {
        e.EdsCloseSession(this.cameraRef as never);
      } catch {
        /* ignore */
      }
      try {
        e.EdsRelease(this.cameraRef as never);
      } catch {
        /* ignore */
      }
      this.cameraRef = 0;
    }
    if (e && this.cameraListRef) {
      try {
        e.EdsRelease(this.cameraListRef as never);
      } catch {
        /* ignore */
      }
      this.cameraListRef = 0;
    }
    if (e) {
      try {
        e.EdsTerminateSDK();
      } catch {
        /* ignore */
      }
    }
    this.eds = null;
    this.lib = null;
    this.bus.emit('camera.disconnected', { reason, at: Date.now() });
  }
}

