import { readdir } from 'node:fs/promises';
import { OUTPUT_DIR } from '~~/server/queue/telegram-queue';

export default defineEventHandler(async () => {
  try {
    const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const ids = new Set<string>();
    for (const name of files) {
      if (name.endsWith('.wm.jpg')) {
        ids.add(name.replace(/\.wm\.jpg$/, ''));
      }
    }
    for (const name of files) {
      if (name.endsWith('.jpg') && !name.endsWith('.wm.jpg')) {
        ids.add(name.replace(/\.jpg$/, ''));
      }
    }
    return { ids: [...ids] };
  } catch {
    return { ids: [] as string[] };
  }
});
