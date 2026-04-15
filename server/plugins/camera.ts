import {context} from "~~/server/main";
import { createCamera } from '~~/server/camera';
import { loggerPluginCamera as logger } from '~~/server/utils/logger';

export default defineNitroPlugin(async () => {
    logger.info('Camera plugin initialized');

    const cameraType = useRuntimeConfig().camera.type;

    const cam = createCamera(cameraType);
    context.camera.cam = cam

    try {
        await cam.connect();
        await cam.startLiveView();
    } catch (err) {
        logger.error('Failed to initialize camera strategy', err);
    }
})