export type CameraState = 'disconnected' | 'connecting' | 'ready' | 'busy' | 'error';

export type CameraType = 'sony_wifi' | 'canon';

export interface LiveViewFrame {
  mimeType: string;
  data: Buffer;
  timestamp: number;
}

export interface CaptureResult {
  id?: string;
  mimeType: string;
  data: Buffer;
  metadata?: Record<string, unknown>;
}

export type LiveViewFrameHandler = (frame: LiveViewFrame) => void;

export interface CameraStrategy {
  readonly type: CameraType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): CameraState;
  startLiveView(): Promise<void>;
  stopLiveView(): Promise<void>;
  subscribeLiveView(handler: LiveViewFrameHandler): () => void;
  capture(): Promise<CaptureResult>;
}
