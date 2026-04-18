import { readdir } from 'node:fs/promises';
import { OUTPUT_DIR } from '~~/server/queue/telegram-queue';

export default defineEventHandler(async () => {
  try {
    const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
    const ids = entries
      .filter((e) => e.isFile() && e.name.endsWith('.wm.jpg'))
      .map((e) => e.name.replace(/\.wm\.jpg$/, ''));
    return { ids };
  } catch {
    return { ids: [] as string[] };
  }
});
