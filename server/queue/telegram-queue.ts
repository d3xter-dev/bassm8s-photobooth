import { join } from 'node:path';
import { createStorage } from 'unstorage';
import fsDriver from 'unstorage/drivers/fs';
import TelegramBot from 'node-telegram-bot-api';
import { loggerTelegramQueue as logger } from '~~/server/utils/logger';

/** JPEGs land here: `{id}.jpg` (original) and `{id}.wm.jpg` (watermarked). */
export const OUTPUT_DIR = join(process.cwd(), 'output');

const photoOutputStorage = createStorage({
  driver: fsDriver({ base: OUTPUT_DIR }),
});

/** Persistent pending Telegram uploads (survives restarts). */
const telegramPendingStorage = createStorage({
  driver: fsDriver({ base: join(OUTPUT_DIR, 'queue', 'pending') }),
});

export type TelegramQueueJob = {
  id: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

function safeJobKey(id: string): string {
  return id.replace(/[/\\:*?"<>|]/g, '_');
}

function jobStorageKey(id: string): string {
  return `job:${safeJobKey(id)}`;
}

function encodeJob(job: TelegramQueueJob): Buffer {
  return Buffer.from(JSON.stringify(job), 'utf8');
}

async function writePendingJob(key: string, job: TelegramQueueJob): Promise<void> {
  await telegramPendingStorage.setItemRaw(key, encodeJob(job));
}

async function readPendingJob(key: string): Promise<TelegramQueueJob | null> {
  const buf = await telegramPendingStorage.getItemRaw(key);
  if (!buf) {
    return null;
  }
  try {
    return JSON.parse(buf.toString('utf8')) as TelegramQueueJob;
  } catch {
    return null;
  }
}

export async function saveCaptureOutputs(
  id: string,
  original: Buffer,
  watermarked: Buffer,
): Promise<void> {
  await Promise.all([
    photoOutputStorage.setItemRaw(`${id}.jpg`, original),
    photoOutputStorage.setItemRaw(`${id}.wm.jpg`, watermarked),
  ]);
}

let queueRerunRequested = false;
let queueProcessing = false;

export async function enqueueTelegramUpload(id: string): Promise<void> {
  const key = jobStorageKey(id);
  const job: TelegramQueueJob = {
    id,
    createdAt: Date.now(),
    attempts: 0,
  };
  await writePendingJob(key, job);
  if (queueProcessing) {
    queueRerunRequested = true;
  } else {
    void processTelegramQueue();
  }
}

let bot: TelegramBot | null = null;
let botToken: string | null = null;

function getBot(token: string): TelegramBot {
  if (!bot || botToken !== token) {
    bot = new TelegramBot(token, { polling: false });
    botToken = token;
  }
  return bot;
}

export async function processTelegramQueue(): Promise<void> {
  if (queueProcessing) {
    return;
  }

  const config = useRuntimeConfig();
  const token = config.telegram.token as string;
  const chatId = (config.telegram.chatId as string) || '-1003984180174';

  if (!token) {
    logger.warn('telegram.token missing; queue will not drain');
    return;
  }

  
  queueProcessing = true;
  try {
    const keys = await telegramPendingStorage.getKeys('');
    const entries: { key: string; job: TelegramQueueJob }[] = [];

    for (const key of keys) {
      const job = await readPendingJob(key);
      if (!job) {
        await telegramPendingStorage.removeItem(key);
        continue;
      }
      entries.push({ key, job });
    }

    entries.sort((a, b) => a.job.createdAt - b.job.createdAt);

    const tg = getBot(token);

    for (const { key, job } of entries) {
      const wmRelPath = `${job.id}.wm.jpg`;
      const wmBuffer = await photoOutputStorage.getItemRaw(wmRelPath).catch(() => null);

      if (!wmBuffer) {
        job.attempts += 1;
        job.lastError = 'watermarked file missing';
        await writePendingJob(key, job);
        logger.error('Telegram queue: missing watermarked file', wmRelPath);
        continue;
      }

      try {
        await tg.sendPhoto(chatId, wmBuffer);
        await telegramPendingStorage.removeItem(key);
        logger.info('Telegram upload OK', job.id);
      } catch (err) {
        job.attempts += 1;
        job.lastError = err instanceof Error ? err.message : String(err);
        await writePendingJob(key, job);
        logger.error('Telegram upload failed', job.id, job.lastError);
      }
    }
  } finally {
    queueProcessing = false;
    if (queueRerunRequested) {
      queueRerunRequested = false;
      void processTelegramQueue();
    }
  }
}
