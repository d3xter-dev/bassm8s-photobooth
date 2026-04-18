import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OUTPUT_DIR } from '~~/server/queue/telegram-queue';
import { applyLogoWatermark } from '~~/server/utils/watermark';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id || /[/\\:*?"<>|]/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }

  const wmPath = join(OUTPUT_DIR, `${id}.wm.jpg`);
  const origPath = join(OUTPUT_DIR, `${id}.jpg`);

  try {
    const buf = await readFile(wmPath);
    setHeader(event, 'Content-Type', 'image/jpeg');
    setHeader(event, 'Cache-Control', 'public, max-age=3600');
    return buf;
  } catch {}

  try {
    const original = await readFile(origPath);
    const buf = await applyLogoWatermark(original);
    setHeader(event, 'Content-Type', 'image/jpeg');
    setHeader(event, 'Cache-Control', 'public, max-age=600');
    return buf;
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }
});
