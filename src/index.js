import fs from 'node:fs';
import cron from 'node-cron';
import { config, paths } from './config.js';
import { logger, purgeOldLogs } from './logger.js';
import { startJornada, endJornada } from './jornada.js';
import { closeBrowser } from './browser.js';
import { notify, sendTelegram } from './notifier.js';
import { escapeHtml, formatARShort, humanizeCron } from './utils.js';
import { isPaused, getState } from './state.js';
import { startListener } from './telegramListener.js';

const listenerAbort = new AbortController();

const formatPausedUntilAR = (iso) => {
  try {
    return `${new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso))} ART`;
  } catch {
    return iso;
  }
};

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
      `⚠️ <b>Sesión no encontrada</b>\n\n` +
        `🔑 No hay sesión guardada en disco.\n` +
        `📂 <code>${escapeHtml(paths.storageState)}</code>\n\n` +
        `▶️ Ejecutá <code>npm run login:bootstrap</code> antes del próximo cron.`,
    );
  }

  const bootState = getState();
  const modoLine = config.dryRun ? '🧪 Modo: <b>DRY_RUN</b> (no clickea)' : '⚙️ Modo: <b>producción</b>';
  const pausedLine = bootState.isPaused
    ? `\n⏸️ Estado: <b>pausado</b>${
        bootState.pausedUntil ? ` hasta ${escapeHtml(formatPausedUntilAR(bootState.pausedUntil))}` : ' (manual)'
      }`
    : '';

  const startupMsg =
    `🤖 <b>Nexus Bot iniciado</b>\n\n` +
    `🕒 ${escapeHtml(formatARShort())}\n` +
    `${modoLine}${pausedLine}\n\n` +
    `<b>Horarios programados</b>\n` +
    `🌅 Inicio · <code>${escapeHtml(humanizeCron(config.cron.start))}</code>\n` +
    `🌇 Fin · <code>${escapeHtml(humanizeCron(config.cron.end))}</code>\n` +
    `💚 Heartbeat · <code>${escapeHtml(humanizeCron(config.cron.heartbeat))}</code>`;
  await notify(startupMsg);

  const cronOpts = { timezone: config.tz };

  cron.schedule(
    config.cron.start,
    () => {
      if (isPaused()) {
        logger.info('Cron CRON_START skipped: bot pausado');
        return;
      }
      logger.info('Cron CRON_START disparó');
      startJornada().catch((err) => logger.error({ err: err.message }, 'startJornada lanzó'));
    },
    cronOpts,
  );

  cron.schedule(
    config.cron.end,
    () => {
      if (isPaused()) {
        logger.info('Cron CRON_END skipped: bot pausado');
        return;
      }
      logger.info('Cron CRON_END disparó');
      endJornada().catch((err) => logger.error({ err: err.message }, 'endJornada lanzó'));
    },
    cronOpts,
  );

  cron.schedule(
    config.cron.heartbeat,
    async () => {
      logger.info('Cron CRON_HEARTBEAT disparó');
      const pausedLine = isPaused() ? '\n⏸️ Estado: pausado' : '';
      await sendTelegram(
        `💚 <b>Heartbeat OK</b>\n\n` +
          `🕒 ${escapeHtml(formatARShort())}${pausedLine}`,
      );
    },
    cronOpts,
  );

  startListener({ signal: listenerAbort.signal }).catch((err) => {
    logger.error({ err: err.message }, 'Listener Telegram terminó con error');
  });

  logger.info('Cron jobs registrados + listener Telegram arrancado, proceso vivo');
};

const shutdown = async (signal) => {
  logger.info({ signal }, 'Recibí señal, cerrando');
  try {
    listenerAbort.abort();
  } catch (err) {
    logger.warn({ err: err.message }, 'Error al abortar listener en shutdown');
  }
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
