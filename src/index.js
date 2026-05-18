import fs from 'node:fs';
import cron from 'node-cron';
import { config, paths } from './config.js';
import { logger, purgeOldLogs } from './logger.js';
import { startJornada, endJornada } from './jornada.js';
import { closeBrowser } from './browser.js';
import { notify, sendTelegram } from './notifier.js';
import { escapeHtml, formatARDate } from './utils.js';

const describeNext = (expr) => `${expr} (TZ ${config.tz})`;

const main = async () => {
  logger.info(
    {
      dryRun: config.dryRun,
      tz: config.tz,
      cron: config.cron,
      logLevel: config.logLevel,
      jitterMaxSec: config.maxJitterSeconds,
    },
    'Nexus Bot iniciado',
  );

  purgeOldLogs();

  if (!fs.existsSync(paths.storageState)) {
    logger.warn('No hay storageState — corré `npm run login:bootstrap` antes del próximo cron');
    await sendTelegram(
      `⚠️ <b>Nexus Bot</b>: no hay sesión guardada en <code>${escapeHtml(paths.storageState)}</code>.\nEjecutá <code>npm run login:bootstrap</code> antes del próximo cron.`,
    );
  }

  const startupMsg =
    `🤖 <b>Nexus Bot iniciado</b>\n` +
    `🕒 ${escapeHtml(formatARDate())}\n` +
    `DRY_RUN=<code>${config.dryRun}</code>\n` +
    `Próximo inicio: <code>${escapeHtml(describeNext(config.cron.start))}</code>\n` +
    `Próximo fin: <code>${escapeHtml(describeNext(config.cron.end))}</code>\n` +
    `Heartbeat: <code>${escapeHtml(describeNext(config.cron.heartbeat))}</code>`;
  await notify(startupMsg);

  const cronOpts = { timezone: config.tz };

  cron.schedule(
    config.cron.start,
    () => {
      logger.info('Cron CRON_START disparó');
      startJornada().catch((err) => logger.error({ err: err.message }, 'startJornada lanzó'));
    },
    cronOpts,
  );

  cron.schedule(
    config.cron.end,
    () => {
      logger.info('Cron CRON_END disparó');
      endJornada().catch((err) => logger.error({ err: err.message }, 'endJornada lanzó'));
    },
    cronOpts,
  );

  cron.schedule(
    config.cron.heartbeat,
    async () => {
      logger.info('Cron CRON_HEARTBEAT disparó');
      const stamp = formatARDate();
      await sendTelegram(`💚 Heartbeat OK — ${escapeHtml(stamp)}`);
    },
    cronOpts,
  );

  logger.info('Cron jobs registrados, proceso vivo');
};

const shutdown = async (signal) => {
  logger.info({ signal }, 'Recibí señal, cerrando');
  try {
    await closeBrowser();
  } catch (err) {
    logger.warn({ err: err.message }, 'Error al cerrar browser en shutdown');
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error({ reason: msg }, 'unhandledRejection');
});

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'main() falló');
  process.exit(1);
});
