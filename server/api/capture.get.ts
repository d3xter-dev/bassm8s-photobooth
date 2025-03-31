import {context} from "~~/server/main";
import SonyCamera from "~~/server/SonyCamera";

export default defineEventHandler(async (event) => {
    const cam  = context.camera.cam as unknown as SonyCamera;

    cam.capture(true, (err, photoName, data) => {
        console.log(err, photoName, data)
    })

    cam.startViewfinder()

    return "ok"
})