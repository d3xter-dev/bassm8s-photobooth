import { context } from '~~/server/main';
import sharp from 'sharp';
import { loggerApiCapture as logger } from '~~/server/utils/logger';
import { enqueueTelegramUpload, saveCaptureOutputs } from '~~/server/queue/telegram-queue';

export default defineEventHandler(async () => {
  const cam = context.camera.cam;
  if (!cam) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Camera is not available',
    });
  }

  const watermark = (await useStorage('assets:assets').getItemRaw('BMD1_Logo.png')) as Buffer;

  const captureResult = await cam.capture();
  const id = captureResult.id ?? `capture-${Date.now()}`;
  logger.info('Captured photo', id);

  /* Canon: bridge `session.capture()` already resumes live view in its `finally`. Do not stop/start here —
   * unawaited calls raced the bridge and could crash EDSDK / Bun. Sony Wi‑Fi: refresh preview if needed. */
  if (cam.type === 'sony_wifi') {
    try {
      await cam.stopLiveView();
      await cam.startLiveView();
    } catch {
      /* ignore */
    }
  }

  const watermarked = await sharp(captureResult.data)
    .composite([
      {
        input: watermark,
        gravity: 'southwest',
        left: 40,
        top: 40,
      },
    ])
    .toBuffer();

  await saveCaptureOutputs(id, captureResult.data, watermarked);
  await enqueueTelegramUpload(id);

  return captureResult.data.toString('base64');
});
