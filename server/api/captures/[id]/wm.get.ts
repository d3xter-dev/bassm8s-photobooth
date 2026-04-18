import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OUTPUT_DIR } from '~~/server/queue/telegram-queue';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id || /[/\\:*?"<>|]/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }

  const filePath = join(OUTPUT_DIR, `${id}.wm.jpg`);
  try {
    const buf = await readFile(filePath);
    setHeader(event, 'Content-Type', 'image/jpeg');
    setHeader(event, 'Cache-Control', 'public, max-age=3600');
    return buf;
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }
});
