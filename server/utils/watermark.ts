import sharp from 'sharp';

function isWatermarkDisabled(): boolean {
  return Boolean(useRuntimeConfig().watermark.disabled);
}

/** Same composite as `api/capture`: logo on southwest with padding. */
export async function applyLogoWatermark(imageJpeg: Buffer): Promise<Buffer> {
  if (isWatermarkDisabled()) {
    return imageJpeg;
  }

  const watermark = (await useStorage('assets:assets').getItemRaw('BMD2_Logo.png')) as Buffer;
  return sharp(imageJpeg)
    .composite([
      {
        input: watermark,
        gravity: 'southwest',
        left: 40,
        top: 40,
      },
    ])
    .toBuffer();
}
