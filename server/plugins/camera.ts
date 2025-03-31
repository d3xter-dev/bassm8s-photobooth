import {context} from "~~/server/main";
import SonyCamera from "~~/server/SonyCamera";


export default defineNitroPlugin((nitroApp) => {
    console.log('Camera plugin')

    const cam = new SonyCamera();
    context.camera.cam = cam

    cam.on('update', function(param, value) {
       console.log(param, value);
    });
    cam.on('liveviewJpeg', function(image) {
        context.camera.image = image.toString('base64')
        console.log('camera.liveviewJpeg', image.toString('base64'));
    });

    cam.connect((err) => {
        console.error(err)
        console.log('Camera plugin', context.camera)
        cam.startViewfinder()
    });

    // setInterval(() => {
    //     context.camera.ping++
    //     console.log('Camera plugin', context.camera)
    // }, 100)
})