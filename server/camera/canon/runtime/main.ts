/// <reference types="bun" />
import { CommandQueue } from '../core/command-queue';
import { EventBus } from '../core/event-bus';
import { BridgeMetrics } from '../core/metrics';
import { ReconnectWorker } from '../workers/reconnect-worker';
import { LiveViewWorker } from '../workers/liveview-worker';
import { EdsdkSession } from '../esdk/session';
import type { BridgeHealth, BridgeState } from '../core/types';

if (typeof Bun === 'undefined') {
  throw new Error('canon-bridge must run with Bun (requires bun:ffi)');
}

/** Copy into a standalone Uint8Array — passing Buffer to `Response` has triggered segfaults in Bun Body/Response on Linux. */
function responseWithJpegBody(jpeg: Buffer): Response {
  const body = new Uint8Array(jpeg.length);
  body.set(jpeg);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}

type ConnectBody = {
  cameraIndex?: number;
  edsdkMacosDylibPath?: string;
  vendorRoot?: string;
};

export function startCanonBridgeServer(): void {
  const port = Number(process.env.CANON_BRIDGE_PORT || 31337);
  const bus = new EventBus();
  const metrics = new BridgeMetrics();
  const queue = new CommandQueue();
  const session = new EdsdkSession(bus, metrics);
  const liveview = new LiveViewWorker(session, bus, metrics);

  let state: BridgeState = 'idle';
  let desiredLiveView = false;
  let lastConnectBody: ConnectBody | null = null;
  let mainLoopTimer: ReturnType<typeof setInterval> | null = null;

  const cameraClients = new Set<{ send: (data: string | Buffer) => void }>();
  const outboundEventQueue: Array<Record<string, unknown>> = [];
  let pendingFrame: Buffer | null = null;

  const reconnect = new ReconnectWorker(
    bus,
    async () => {
      if (!lastConnectBody) return false;
      state = 'reconnecting';
      try {
        await queue.enqueue(async () => {
          await session.connect({
            cameraIndex: lastConnectBody?.cameraIndex ?? 0,
            edsdkMacosDylibPath: lastConnectBody?.edsdkMacosDylibPath,
            vendorRoot: lastConnectBody?.vendorRoot
          });
          state = 'connected';
          if (desiredLiveView) {
            await session.startLiveView();
            liveview.start();
            state = 'liveview';
          }
        }, { timeoutMs: 30_000, label: 'reconnect' });
        return true;
      } catch {
        return false;
      }
    },
    { initialDelayMs: 400, maxDelayMs: 12_000 }
  );

  function broadcastText(payload: Record<string, unknown>): void {
    const text = JSON.stringify(payload);
    for (const ws of cameraClients) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  function enqueueOutboundEvent(payload: Record<string, unknown>): void {
    outboundEventQueue.push(payload);
    if (outboundEventQueue.length > 2048) {
      outboundEventQueue.splice(0, outboundEventQueue.length - 2048);
    }
  }

  bus.on('liveview.frame', ({ jpeg }) => {
    pendingFrame = jpeg;
  });

  bus.on('camera.connected', ({ at }) => {
    reconnect.stop();
    enqueueOutboundEvent({ type: 'camera_connected', at });
  });

  bus.on('camera.disconnected', ({ reason, at }) => {
    enqueueOutboundEvent({ type: 'camera_disconnected', reason, at });
    if (state !== 'disconnecting' && state !== 'closed') {
      state = 'degraded';
      if (lastConnectBody) reconnect.start(reason);
    }
  });

  bus.on('camera.error', ({ error, at }) => {
    enqueueOutboundEvent({ type: 'camera_error', error, at });
  });

  bus.on('camera.state-event', ({ event, payload, at }) => {
    enqueueOutboundEvent({ type: 'camera_state_event', event, payload, at });
  });

  bus.on('camera.property-event', ({ event, propertyId, at }) => {
    enqueueOutboundEvent({ type: 'camera_property_event', event, propertyId, at });
  });

  bus.on('liveview.started', ({ at }) => {
    enqueueOutboundEvent({ type: 'liveview_started', at });
  });

  bus.on('liveview.stopped', ({ reason, at }) => {
    enqueueOutboundEvent({ type: 'liveview_stopped', reason, at });
  });

  bus.on('capture.completed', ({ bytes, at }) => {
    enqueueOutboundEvent({ type: 'capture_completed', bytes, at });
  });

  bus.on('capture.failed', ({ error, at }) => {
    enqueueOutboundEvent({ type: 'capture_failed', error, at });
  });

  function startMainLoop(): void {
    if (mainLoopTimer) return;
    mainLoopTimer = setInterval(() => {
      session.getEvent();
      if (pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        for (const ws of cameraClients) {
          try {
            ws.send(frame);
          } catch {
            /* ignore */
          }
        }
      }
      if (outboundEventQueue.length > 0) {
        const batch = outboundEventQueue.splice(0, 64);
        for (const payload of batch) {
          broadcastText(payload);
        }
      }
    }, 1);
  }

  function health(): BridgeHealth {
    return {
      ok: true,
      state,
      eds: session.hasEds,
      camera: session.isConnected,
      liveView: liveview.isRunning && session.hasLiveView,
      queueDepth: queue.depth(),
      reconnecting: reconnect.isRunning,
      metrics: metrics.snapshot()
    };
  }

  async function connect(body: ConnectBody): Promise<void> {
    state = 'initializing';
    lastConnectBody = body;
    reconnect.stop();
    await session.connect({
      cameraIndex: body.cameraIndex ?? 0,
      edsdkMacosDylibPath: body.edsdkMacosDylibPath,
      vendorRoot: body.vendorRoot
    });
    state = 'connected';
  }

  async function disconnect(reason = 'disconnect'): Promise<void> {
    desiredLiveView = false;
    state = 'disconnecting';
    reconnect.stop();
    liveview.stop(reason);
    await session.disconnect(reason);
    state = 'idle';
  }

  async function startLiveView(): Promise<void> {
    desiredLiveView = true;
    await session.startLiveView();
    liveview.start();
    state = 'liveview';
  }

  async function stopLiveView(reason = 'stop_liveview'): Promise<void> {
    desiredLiveView = false;
    liveview.stop(reason);
    await session.stopLiveView(reason);
    if (session.isConnected) state = 'connected';
  }

  Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws/camera' || url.pathname === '/ws/liveview') {
        const ok = server.upgrade(req, { data: { channel: 'camera' as const } });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 500 });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json(health());
      }

      if (req.method === 'POST' && url.pathname === '/connect') {
        return (async () => {
          try {
            const body = (await req.json().catch(() => ({}))) as ConnectBody;
            await queue.enqueue(async () => {
              await connect(body);
            }, { timeoutMs: 45_000, label: 'connect' });
            return Response.json({ ok: true });
          } catch (error) {
            state = 'degraded';
            return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
          }
        })();
      }

      if (req.method === 'POST' && url.pathname === '/disconnect') {
        return (async () => {
          await queue.enqueue(async () => {
            await disconnect('http_disconnect');
          }, { timeoutMs: 10_000, label: 'disconnect' });
          return Response.json({ ok: true });
        })();
      }

      if (req.method === 'POST' && url.pathname === '/liveview/start') {
        return (async () => {
          try {
            await queue.enqueue(async () => {
              if (!session.isConnected) throw new Error('not connected');
              await startLiveView();
            }, { timeoutMs: 15_000, label: 'liveview-start' });
            return Response.json({ ok: true });
          } catch (error) {
            return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
          }
        })();
      }

      if (req.method === 'POST' && url.pathname === '/liveview/stop') {
        return (async () => {
          await queue.enqueue(async () => {
            await stopLiveView('http_stop');
          }, { timeoutMs: 10_000, label: 'liveview-stop' });
          return Response.json({ ok: true });
        })();
      }

      if (req.method === 'POST' && url.pathname === '/capture') {
        return (async () => {
          try {
            const jpeg = await queue.enqueue(async () => {
              if (!session.isConnected) throw new Error('not connected');
              return await session.capture();
            }, { timeoutMs: 70_000, label: 'capture' });
            bus.emit('capture.completed', { bytes: jpeg.length, at: Date.now() });
            return responseWithJpegBody(jpeg);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            bus.emit('capture.failed', { error: message, at: Date.now() });
            return Response.json({ ok: false, error: message }, { status: 500 });
          }
        })();
      }

      if (req.method === 'POST' && url.pathname === '/capture/shutter') {
        return (async () => {
          try {
            await queue.enqueue(async () => {
              if (!session.isConnected) throw new Error('not connected');
              await session.triggerShutter();
            }, { timeoutMs: 30_000, label: 'capture-shutter' });
            return Response.json({ ok: true });
          } catch (error) {
            return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
          }
        })();
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        cameraClients.add(ws as unknown as { send: (data: string | Buffer) => void });
      },
      close(ws) {
        cameraClients.delete(ws as unknown as { send: (data: string | Buffer) => void });
      },
      message() {
        /* no-op */
      }
    }
  });

  startMainLoop();
  console.log(`[canon-bridge] listening on http://127.0.0.1:${port} (Bun FFI + EDSDK)`);
}

