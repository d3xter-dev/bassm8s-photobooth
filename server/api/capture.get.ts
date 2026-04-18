import { context } from '~~/server/main';
import { loggerApiCapture as logger } from '~~/server/utils/logger';
import { applyLogoWatermark } from '~~/server/utils/watermark';
import { enqueueTelegramUpload, saveCaptureOutputs } from '~~/server/queue/telegram-queue';

export default defineEventHandler(async () => {
  const cam = context.camera.cam;
  if (!cam) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Camera is not available',
    });
  }

  const captureResult = await cam.capture();
  const id = captureResult.id ?? `capture-${Date.now()}`;
  logger.info('Captured photo', id);

  cam.stopLiveView();
  cam.startLiveView();

  const watermarked = await applyLogoWatermark(captureResult.data);

  await saveCaptureOutputs(id, captureResult.data, watermarked);

  void enqueueTelegramUpload(id).catch((err) => {
    logger.warn('Telegram enqueue failed after capture (files saved on disk)', err);
  });

  return {
    id,
    imageBase64: watermarked.toString('base64'),
  };
});
