import { consola } from 'consola';

export const loggerPluginCamera = consola.withTag('plugin:camera');
export const loggerApiCapture = consola.withTag('api:capture');
export const loggerWsLiveview = consola.withTag('ws:liveview');
export const loggerCamera = consola.withTag('camera');

export type TaggedLogger = ReturnType<typeof consola.withTag>;
