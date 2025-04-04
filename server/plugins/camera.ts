import {context} from "~~/server/main";
import SonyCamera from "~~/server/SonyCamera";


export default defineNitroPlugin((nitroApp) => {
    console.log('Camera plugin')

    const cam = new SonyCamera();
    context.camera.cam = cam

    cam.on('liveviewJpeg', function(image) {
        context.camera.image = image.toString('base64')
    });

    cam.on('connect', () => {
        cam.startViewfinder()
    })

    cam.connect((err) => {
        console.error(err)
    });
})