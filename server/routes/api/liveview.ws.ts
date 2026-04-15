import { context } from '~~/server/main';
import { loggerWsLiveview as logger } from '~~/server/utils/logger';

const subscriptions = new Map<object, () => void>();

export default defineWebSocketHandler({
  open(peer) {
    const cam = context.camera.cam;
    if (!cam) {
      peer.send(JSON.stringify({ type: 'error', message: 'Camera is not available' }));
      logger.warn('Rejected websocket peer: camera unavailable');
      return;
    }

    const unsubscribe = cam.subscribeLiveView((frame) => {
      // Stream raw JPEG bytes to avoid base64 overhead.
      peer.send(frame.data);
    });
    subscriptions.set(peer as object, unsubscribe);
    logger.debug('Liveview peer connected');
  },
  close(peer) {
    const unsubscribe = subscriptions.get(peer as object);
    if (unsubscribe) {
      unsubscribe();
      subscriptions.delete(peer as object);
    }
    logger.debug('Liveview peer disconnected');
  },
  error(peer) {
    const unsubscribe = subscriptions.get(peer as object);
    if (unsubscribe) {
      unsubscribe();
      subscriptions.delete(peer as object);
    }
    logger.warn('Liveview peer errored and was cleaned up');
  }
});
