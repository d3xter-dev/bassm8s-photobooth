import type { CameraStrategy, CameraType } from '~~/server/camera/types';
import { createCamera } from '~~/server/camera';
import { briefCameraConnectError } from '~~/server/camera/canon/connection-errors';
import { context } from '~~/server/main';
import { loggerPluginCamera as logger } from '~~/server/utils/logger';

let shutdownInFlight: Promise<void> | null = null;
let shuttingDown = false;
let lastInitLogAt = 0;

async function initializeCameraWithBackoff(cam: CameraStrategy): Promise<void> {
  let delay = 300;
  const maxDelay = 8_000;
  while (!shuttingDown && cam.getState() !== 'ready') {
    try {
      await cam.connect();
      if (shuttingDown) return;
      await cam.startLiveView();
      return;
    } catch (err) {
      if (shuttingDown) return;
      const now = Date.now();
      if (now - lastInitLogAt >= 12_000) {
        lastInitLogAt = now;
        logger.info(`Camera: ${briefCameraConnectError(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(maxDelay, Math.floor(delay * 1.8));
    }
  }
}

async function shutdownCameraOnHostExit(cam: CameraStrategy): Promise<void> {
  shuttingDown = true;
  if (!shutdownInFlight) {
    shutdownInFlight = (async () => {
      try {
        await Promise.race([
          cam.disconnect(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000))
        ]);
      } catch (error) {
        logger.warn('Camera shutdown on host exit failed', error);
      } finally {
        shutdownInFlight = null;
      }
    })();
  }
  await shutdownInFlight;
}

export default defineNitroPlugin((nitroApp) => {
  logger.info('Camera plugin initialized');

  const runtime = useRuntimeConfig();
  const cameraType = runtime.camera.type as string;

  let cam: CameraStrategy;
  try {
    cam = createCamera(cameraType as CameraType);
  } catch (e) {
    logger.error('Invalid camera type', e);

    
    return;
  }
  context.camera.cam = cam;

  void initializeCameraWithBackoff(cam);

  nitroApp.hooks.hook('close', async () => {
    await shutdownCameraOnHostExit(cam);
  });
});
