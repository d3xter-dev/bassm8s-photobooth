import { CameraState, CameraStrategy, CameraType, CaptureResult, LiveViewFrameHandler } from "../types";
import { loggerCamera as logger, type TaggedLogger } from '~~/server/utils/logger';

class CanonCamera implements CameraStrategy {
    readonly type: CameraType = 'canon';
    logger: TaggedLogger;

    constructor() {
        this.logger = logger;
    }
    
    connect(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    disconnect(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getState(): CameraState {
        throw new Error("Method not implemented.");
    }
    startLiveView(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    stopLiveView(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    subscribeLiveView(handler: LiveViewFrameHandler): () => void {
        throw new Error("Method not implemented.");
    }
    capture(): Promise<CaptureResult> {
        throw new Error("Method not implemented.");
    }
}

export default CanonCamera;