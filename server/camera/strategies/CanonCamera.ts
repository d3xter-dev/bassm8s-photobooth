import type { ChildProcess } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import type {
  CameraState,
  CameraStrategy,
  CameraType,
  CaptureResult,
  LiveViewFrame,
  LiveViewFrameHandler
} from '../types';
import {
  isCanonBridgeReachable,
  spawnCanonBridge,
  waitForBridgeHealth
} from '~~/server/camera/canon/spawn-bridge';
import { loggerCamera as logger, type TaggedLogger } from '~~/server/utils/logger';
import WebSocket, { type RawData } from 'ws';

function httpToWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export default class CanonCamera implements CameraStrategy {
  readonly type: CameraType = 'canon';
  logger: TaggedLogger;
  private state: CameraState = 'disconnected';
  private bridgeBase: string;
  private cameraIndex: number;
  private edsdkMacosDylibPath?: string;
  private edsdkVendorRoot?: string;
  /** When true, `connect()` may spawn the local Bun bridge (only for localhost bases). */
  private canonBridgeAutostart: boolean;
  /** Child we spawned; killed in `disconnect()` so the port is free and the process exits. */
  private bridgeChildProcess: ChildProcess | null = null;

  private liveViewSubscribers = new Set<LiveViewFrameHandler>();
  /** Single bridge socket: binary = EVF JPEG, text = JSON (`camera_disconnected`, …). */
  private cameraBridgeWs: WebSocket | null = null;
  private liveViewStarted = false;
  private reconnectInFlight = false;
  private connectInFlight: Promise<void> | null = null;

  constructor() {
    this.logger = logger;
    const config = useRuntimeConfig();
    const cam = config.camera as {
      canonBridgeUrl?: string;
      canonBridgePort?: number;
      canonBridgeAutostart?: boolean;
      canonCameraIndex?: number;
      edsdkMacosDylibPath?: string;
      edsdkVendorRoot?: string;
    };
    const port = cam.canonBridgePort ?? 31337;
    this.bridgeBase = cam.canonBridgeUrl && cam.canonBridgeUrl.length > 0 ? cam.canonBridgeUrl : `http://127.0.0.1:${port}`;
    this.cameraIndex = cam.canonCameraIndex ?? 0;
    this.edsdkMacosDylibPath = cam.edsdkMacosDylibPath || undefined;
    this.edsdkVendorRoot = cam.edsdkVendorRoot || undefined;
    this.canonBridgeAutostart = cam.canonBridgeAutostart !== false;
  }

  private bridgePortForSpawn(): number {
    const u = new URL(this.bridgeBase);
    if (u.port) {
      return Number.parseInt(u.port, 10);
    }
    return 31337;
  }

  /** Only autostart a local sidecar; never spawn for a remote `canonBridgeUrl`. */
  private shouldAutostartLocalBridge(): boolean {
    if (!this.canonBridgeAutostart) {
      return false;
    }
    try {
      const h = new URL(this.bridgeBase).hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
    } catch {
      return false;
    }
  }

  getState(): CameraState {
    return this.state;
  }

  private publishLiveViewFrame(image: Buffer): void {
    const frame: LiveViewFrame = {
      mimeType: 'image/jpeg',
      data: image,
      timestamp: Date.now()
    };
    for (const sub of this.liveViewSubscribers) {
      sub(frame);
    }
  }

  private getWsCameraUrl(): string {
    const base = new URL(this.bridgeBase);
    base.pathname = '/ws/camera';
    return httpToWsUrl(base.toString());
  }

  private rawDataToBuffer(data: RawData): Buffer {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (Array.isArray(data)) return Buffer.concat(data);
    if (Buffer.isBuffer(data)) return data;
    return Buffer.from(data);
  }

  private async fetchJson(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {}
  ): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }> {
    const { timeoutMs = 10_000, ...rest } = init;
    const url = new URL(path, this.bridgeBase).toString();
    const r = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; [k: string]: unknown };
    if (!r.ok || j.ok === false) {
      throw new Error(j.error || `${path} failed: ${r.status}`);
    }
    return j;
  }

  /** Bun → `ws` may omit `isBinary` or mislabel binary EVF JPEG; use SOI marker. */
  private isJpegFrame(buf: Buffer): boolean {
    return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
  }

  /**
   * Wait until the bridge `/ws/camera` socket is open so Bun has registered `cameraClients`
   * before `/liveview/start` broadcasts frames.
   */
  private async ensureCameraBridgeSocket(): Promise<void> {
    const existing = this.cameraBridgeWs;
    if (existing) {
      if (existing.readyState === WebSocket.OPEN) {
        return;
      }
      if (existing.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Canon bridge WebSocket open timeout')), 15_000);
          existing.once('open', () => {
            clearTimeout(t);
            resolve();
          });
          existing.once('error', (e) => {
            clearTimeout(t);
            reject(e);
          });
        });
        return;
      }
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      this.cameraBridgeWs = null;
    }

    const url = this.getWsCameraUrl();
    const ws = new WebSocket(url);

    ws.on('message', (data: RawData) => {
      const buf = this.rawDataToBuffer(data);
      if (this.isJpegFrame(buf)) {
        if (buf.length) this.publishLiveViewFrame(buf);
        return;
      }
      const text = buf.toString('utf8');
      let msg: { type?: string; reason?: string };
      try {
        msg = JSON.parse(text) as { type?: string; reason?: string };
      } catch {
        return;
      }
      if (msg.type === 'camera_disconnected') {
        this.handleBridgeCameraLost(msg.reason ?? 'unknown');
      }
    });
    ws.on('error', (e) => {
      this.logger.warn('Canon bridge WebSocket error', e);
    });
    ws.on('close', () => {
      if (this.cameraBridgeWs !== ws) return;
      this.cameraBridgeWs = null;
      if (this.liveViewStarted && this.liveViewSubscribers.size > 0) {
        setTimeout(() => {
          if (this.liveViewStarted && this.liveViewSubscribers.size > 0) {
            void this.ensureCameraBridgeSocket();
          }
        }, 400);
      }
    });

    this.cameraBridgeWs = ws;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Canon bridge WebSocket open timeout')), 15_000);
      ws.once('open', () => {
        clearTimeout(t);
        this.logger.debug({ url }, 'Canon bridge WebSocket connected');
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private handleBridgeCameraLost(reason: string): void {
    if (this.state === 'disconnected') return;
    if (this.reconnectInFlight) return;
    this.reconnectInFlight = true;
    this.logger.warn({ reason }, 'Canon bridge reported camera lost');
    this.liveViewStarted = false;
    if (this.cameraBridgeWs) {
      try {
        this.cameraBridgeWs.close();
      } catch {
        /* ignore */
      }
      this.cameraBridgeWs = null;
    }
    this.state = 'connecting';
    void this.runReconnectLoop(reason).finally(() => {
      this.reconnectInFlight = false;
    });
  }

  private async runReconnectLoop(reason: string): Promise<void> {
    this.logger.info({ reason }, 'Canon: attempting reconnect after camera loss');
    let delay = 500;
    const maxDelay = 10_000;
    while (true) {
      if (this.getState() === 'disconnected') return;
      await new Promise((r) => setTimeout(r, delay));
      if (this.getState() === 'disconnected') return;
      try {
        await this.connect();
        if (this.liveViewSubscribers.size > 0) {
          try {
            await this.startLiveView();
          } catch (e) {
            this.logger.warn({ err: e }, 'Canon reconnect: startLiveView failed (non-fatal)');
          }
        }
        return;
      } catch (e) {
        this.logger.warn({ err: e }, 'Canon reconnect attempt failed');
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connectInFlight) {
      await this.connectInFlight;
      return;
    }
    this.connectInFlight = (async () => {
      this.state = 'connecting';
      try {
        if (this.shouldAutostartLocalBridge()) {
          if (await isCanonBridgeReachable(this.bridgeBase, 2500)) {
            this.logger.info({ base: this.bridgeBase }, 'Canon EDSDK Bun bridge already running');
            if (process.env.NODE_ENV !== 'production') {
              this.logger.warn(
                'Edits to canon-bridge.ts only load after the Bun bridge exits. Kill stale bridge processes if logs look outdated.'
              );
            }
          } else {
            const p = this.bridgePortForSpawn();
            this.bridgeChildProcess = spawnCanonBridge(p);
            await waitForBridgeHealth(this.bridgeBase, 20000);
            this.logger.info({ base: this.bridgeBase }, 'Canon EDSDK Bun bridge started');
          }
        }

        await this.fetchJson('/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: 30_000,
          body: JSON.stringify({
            cameraIndex: this.cameraIndex,
            ...(this.edsdkMacosDylibPath ? { edsdkMacosDylibPath: this.edsdkMacosDylibPath } : {}),
            ...(this.edsdkVendorRoot ? { vendorRoot: this.edsdkVendorRoot } : {})
          })
        })
        this.state = 'ready';
      } catch (e) {
        this.state = 'error';
        if (this.bridgeChildProcess) {
          try {
            this.bridgeChildProcess.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          this.bridgeChildProcess = null;
        }
        throw e;
      } finally {
        this.connectInFlight = null;
      }
    })();
    await this.connectInFlight;
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
    if (this.cameraBridgeWs) {
      try {
        this.cameraBridgeWs.close();
      } catch {
        /* ignore */
      }
      this.cameraBridgeWs = null;
    }
    this.liveViewStarted = false;
    try {
      await this.fetchJson('/disconnect', { method: 'POST', timeoutMs: 2500 });
    } catch {
      /* ignore — bridge may already be gone */
    } finally {
      if (this.bridgeChildProcess) {
        try {
          this.bridgeChildProcess.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        this.bridgeChildProcess = null;
      }
    }
  }

  async startLiveView(): Promise<void> {
    this.logger.info('Canon bridge liveview start');
    await this.fetchJson('/liveview/start', { method: 'POST', timeoutMs: 15_000 });

    this.logger.info('Canon bridge liveview started');
    this.liveViewStarted = true;
    try {
      await this.ensureCameraBridgeSocket();
    } catch (e) {
      this.logger.warn({ err: e }, 'Canon bridge WebSocket failed after startLiveView');
    }
  }

  async stopLiveView(): Promise<void> {
    try {
      await this.fetchJson('/liveview/stop', { method: 'POST', timeoutMs: 10_000 });
    } catch {
      /* ignore */
    }
    this.liveViewStarted = false;
  }

  subscribeLiveView(handler: LiveViewFrameHandler): () => void {
    this.liveViewSubscribers.add(handler);
    if (this.liveViewStarted) {
      void this.ensureCameraBridgeSocket();
    }
    return () => {
      this.liveViewSubscribers.delete(handler);
    };
  }

  async capture(): Promise<CaptureResult> {
    if (this.state !== 'ready') {
      throw new Error('camera not ready');
    }
    this.state = 'busy';
    try {
      const r = await fetch(new URL('/capture', this.bridgeBase).toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(70_000)
      });
      const contentType = r.headers.get('content-type') || '';
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `capture failed: ${r.status}`);
      }
      if (contentType.includes('application/json')) {
        const j = (await r.json()) as {
          ok?: boolean;
          path?: string;
          imageBase64?: string;
          mimeType?: string;
          error?: string;
        };
        if (j.ok === false) {
          throw new Error(j.error || 'capture failed');
        }
        if (j.path && typeof j.path === 'string') {
          try {
            const data = await readFile(j.path);
            this.state = 'ready';
            return {
              mimeType: j.mimeType || 'image/jpeg',
              data,
              id: `canon-${Date.now()}`
            };
          } finally {
            await unlink(j.path).catch(() => {});
          }
        }
        if (j.imageBase64) {
          const data = Buffer.from(j.imageBase64, 'base64');
          this.state = 'ready';
          return {
            mimeType: j.mimeType || 'image/jpeg',
            data,
            id: `canon-${Date.now()}`
          };
        }
        throw new Error(j.error || 'capture failed: no path or imageBase64');
      }
      const data = Buffer.from(await r.arrayBuffer());
      this.state = 'ready';
      return {
        mimeType: contentType || 'image/jpeg',
        data,
        id: `canon-${Date.now()}`
      };
    } catch (e) {
      this.state = 'ready';
      throw e;
    }
  }
}
