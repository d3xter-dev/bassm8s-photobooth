import {context} from "~~/server/main";

export default defineEventHandler(async (event) => {
    return context.camera.image
})