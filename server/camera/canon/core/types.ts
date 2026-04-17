export type BridgeState =
  | 'idle'
  | 'initializing'
  | 'connected'
  | 'liveview'
  | 'degraded'
  | 'disconnecting'
  | 'reconnecting'
  | 'closed';

export type BridgeEventMap = {
  'camera.connected': { at: number };
  'camera.disconnected': { reason: string; at: number };
  'camera.error': { error: string; at: number };
  'camera.state-event': { event: number; payload: number; at: number };
  'camera.property-event': { event: number; propertyId: number; at: number };
  'liveview.frame': { jpeg: Buffer; at: number };
  'liveview.started': { at: number };
  'liveview.stopped': { at: number; reason: string };
  'capture.completed': { bytes: number; at: number };
  'capture.failed': { error: string; at: number };
};

export type BridgeHealth = {
  ok: boolean;
  state: BridgeState;
  eds: boolean;
  camera: boolean;
  liveView: boolean;
  queueDepth: number;
  reconnecting: boolean;
  metrics: {
    frameAvgMs: number;
    frameP95Ms: number;
    frameMaxMs: number;
    framesPerSecond: number;
    droppedFrames: number;
    pumpBlockMaxMs: number;
  };
};

