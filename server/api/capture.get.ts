import {context} from "~~/server/main";
import TelegramBot from "node-telegram-bot-api";
import sharp from "sharp";
import { loggerApiCapture as logger } from '~~/server/utils/logger';

export default defineEventHandler(async () => {
    const cam = context.camera.cam;
    if (!cam) {
        throw createError({
            statusCode: 503,
            statusMessage: 'Camera is not available'
        });
    }

    const watermark = (await useStorage('assets:assets').getItemRaw('BMD1_Logo.png'))
    const token = useRuntimeConfig().telegram.token;
    const bot = new TelegramBot(token);

    const captureResult = await cam.capture();
    logger.info('Captured photo', captureResult.id);

    const watermarked = await sharp(captureResult.data)
        .composite([{
            input: watermark,
            gravity: 'southwest',
            left: 40,
            top: 40
        }]).toBuffer();

    // await bot.sendPhoto('@BASSM8S_Photobooth', watermarked);
     await bot.sendPhoto('-1003984180174', watermarked);

    return captureResult.data.toString('base64');
})