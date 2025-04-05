import {context} from "~~/server/main";
import SonyCamera from "~~/server/SonyCamera";
import TelegramBot from "node-telegram-bot-api";

export default defineEventHandler(async (event) => {
    const cam  = context.camera.cam as unknown as SonyCamera;

    const token = useRuntimeConfig().telegram.token;
    const bot = new TelegramBot(token);

    const promise = new Promise<string>((resolve) => {
        cam.capture(false, (err, photoName, data) => {
            console.log(photoName)
            if(!data) return resolve('')

            bot.sendPhoto('BASSM8S_Photobooth', Buffer.from(data), {caption: photoName})

            resolve(data?.toString('base64'))
        })
    })
    return await promise
})