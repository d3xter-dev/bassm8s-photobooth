import { processTelegramQueue } from '~~/server/queue/telegram-queue';
import { loggerTelegramQueue as logger } from '~~/server/utils/logger';

const DRAIN_INTERVAL_MS = 5000;

export default defineNitroPlugin((nitroApp) => {
  logger.info('Telegram upload queue plugin initialized');

  void processTelegramQueue();

  const interval = setInterval(() => {
    void processTelegramQueue();
  }, DRAIN_INTERVAL_MS);

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval);
  });
});
