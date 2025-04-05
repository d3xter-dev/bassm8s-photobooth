import {context} from "~~/server/main";
import SonyCamera from "~~/server/SonyCamera";
import TelegramBot from "node-telegram-bot-api";
import sharp, {Sharp} from "sharp";

export default defineEventHandler(async (event) => {
    const cam  = context.camera.cam as unknown as SonyCamera;

    const watermark = (await useStorage('assets:assets').getItemRaw('BMD1_Logo.png'))
    const token = useRuntimeConfig().telegram.token;
    const bot = new TelegramBot(token);

    const promise = new Promise<string>((resolve) => {
        cam.capture(false, async (err, photoName, data) => {
            console.log(photoName)
            if(!data) return resolve('')

            const watermarked = await sharp(data)
                .composite([{
                    input: watermark,
                    gravity: 'southwest',
                    left: 40,
                    top: 40
                }]).toBuffer();

            await bot.sendPhoto('@BASSM8S_Photobooth', watermarked)

            resolve(data?.toString('base64'))
        })
    })
    return await promise
})