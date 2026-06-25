import { context } from '~~/server/main';
import { loggerApiCapture as logger } from '~~/server/utils/logger';
import { applyLogoWatermark } from '~~/server/utils/watermark';
import { enqueueTelegramUpload, saveCaptureOutputs } from '~~/server/queue/telegram-queue';

let captureInFlight: Promise<{ id: string; previewUrl: string }> | null = null;

export default defineEventHandler(async () => {
  if (captureInFlight) {
    throw createError({ statusCode: 409, statusMessage: 'Capture already in progress' });
  }

  captureInFlight = (async () => {
  const cam = context.camera.cam;
  if (!cam) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Camera is not available',
    });
  }

  const isCanon = cam.type === 'canon';

  /** Sony needs an explicit stop; Canon bridge handles liveview inside /capture. */
  if (!isCanon) {
    try {
      await cam.stopLiveView();
    } catch (err) {
      logger.warn('stopLiveView before capture failed', err);
    }
  }

  const captureResult = await cam.capture();
  const id = captureResult.id ?? `capture-${Date.now()}`;
  logger.info('Captured photo', id);

  if (!isCanon) {
    try {
      await cam.startLiveView();
    } catch (err) {
      logger.warn('startLiveView after capture failed', err);
    }
  }

  const watermarked = await applyLogoWatermark(captureResult.data);

  await saveCaptureOutputs(id, captureResult.data, watermarked);

  void enqueueTelegramUpload(id).catch((err) => {
    logger.warn('Telegram enqueue failed after capture (files saved on disk)', err);
  });

  return {
    id,
    previewUrl: `/api/captures/${encodeURIComponent(id)}/wm`,
  };
  })();

  try {
    return await captureInFlight;
  } finally {
    captureInFlight = null;
  }
});
