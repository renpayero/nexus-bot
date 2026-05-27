import { config } from './config.js';
import { logger } from './logger.js';
import { sendTelegram } from './notifier.js';
import { getState, setPaused, isPaused } from './state.js';
import { escapeHtml, formatARShort, humanizeCron, sleep } from './utils.js';
import { getStatus, endJornada } from './jornada.js';
import { refreshSession } from './browser.js';

const POLL_TIMEOUT_SEC = 30;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const CONFLICT_BACKOFF_MS = 60_000;

const telegramApi = (method) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

const authorizedChatId = () => Number(config.telegram.chatId);

const formatPausedUntilAR = (iso) => {
  try {
    return formatARShort(new Date(iso));
  } catch {
    return iso;
  }
};

const replyToChat = async (chatId, text) => {
  try {
    const res = await fetch(telegramApi('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      logger.warn({ status: res.status, body }, 'reply a comando falló');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'reply a comando lanzó');
  }
};

const HELP_TEXT =
  `🤖 <b>Nexus Bot · comandos</b>\n\n` +
  `<b>⏸️ Pausar / reanudar</b>\n` +
  `<code>/pause</code> — pausa indefinida (chequea jornada antes)\n` +
  `<code>/pause N</code> — pausa por N días, auto-reanuda\n` +
  `<code>/pause force</code> — pausa sin chequear\n` +
  `<code>/resume</code> — reanudar\n\n` +
  `<b>⚙️ Acciones</b>\n` +
  `<code>/end-now</code> — finalizar jornada ahora\n\n` +
  `<b>ℹ️ Info</b>\n` +
  `<code>/status</code> — estado y horarios\n` +
  `<code>/help</code> — esta ayuda`;

const fetchNexusStatus = async () => {
  try {
    return { ok: true, state: await getStatus() };
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED' || err.message === 'SESSION_EXPIRED') {
      try {
        await refreshSession();
        return { ok: true, state: await getStatus(), refreshed: true };
      } catch (err2) {
        return { ok: false, error: `refresh+getStatus: ${err2.message}` };
      }
    }
    return { ok: false, error: err.message };
  }
};

const handleEndNow = async (chatId) => {
  await replyToChat(
    chatId,
    `🔄 <b>Finalización en curso</b>\n\n` +
      `▶️ Disparando flujo de cierre de jornada.\n` +
      `📨 Te aviso el resultado en cuanto termine.`,
  );
  endJornada().catch((err) => {
    logger.error({ err: err.message }, 'endJornada disparado por /end-now lanzó');
  });
};

const handlePause = async (chatId, args) => {
  let force = false;
  const argList = [...args];
  if (argList[0]?.toLowerCase() === 'force') {
    force = true;
    argList.shift();
  }

  const state = getState();
  if (state.isPaused) {
    const expira = state.pausedUntil
      ? `⏳ Expira: ${escapeHtml(formatPausedUntilAR(state.pausedUntil))}`
      : `⏳ Modo: manual (hasta <code>/resume</code>)`;
    await replyToChat(
      chatId,
      `ℹ️ <b>Ya estaba pausado</b>\n\n${expira}`,
    );
    return;
  }

  if (!force) {
    await replyToChat(
      chatId,
      `🔍 <b>Verificando estado</b>\n\n▶️ Consultando jornada en Nexus...`,
    );
    const probe = await fetchNexusStatus();
    if (!probe.ok) {
      logger.warn({ err: probe.error }, '/pause: no pude verificar estado');
      await replyToChat(
        chatId,
        `⚠️ <b>No pude verificar el estado</b>\n\n` +
          `💬 <code>${escapeHtml(probe.error.slice(0, 200))}</code>\n\n` +
          `▶️ Si querés pausar igual: <code>/pause force</code>`,
      );
      return;
    }
    if (probe.state === 'in_progress') {
      await replyToChat(
        chatId,
        `⚠️ <b>Jornada abierta en Nexus</b>\n\n` +
          `🔍 Estado actual: <code>in_progress</code>\n\n` +
          `<b>¿Qué hacer?</b>\n` +
          `1️⃣  Finalizá con <code>/end-now</code>\n` +
          `2️⃣  Después <code>/pause</code>\n\n` +
          `ℹ️ Si ya cerraste a mano en la web: <code>/pause force</code>`,
      );
      return;
    }
    if (probe.state === 'unknown') {
      await replyToChat(
        chatId,
        `⚠️ <b>Estado UNKNOWN</b>\n\n` +
          `🚨 Los selectores podrían estar rotos. No pauso por seguridad.\n\n` +
          `▶️ Si querés pausar igual: <code>/pause force</code>`,
      );
      return;
    }
  }

  let pausedUntil;
  if (argList.length > 0) {
    const n = Number.parseInt(argList[0], 10);
    if (!Number.isFinite(n) || n <= 0) {
      await replyToChat(
        chatId,
        `⚠️ <b>Uso incorrecto</b>\n\n` +
          `<code>/pause</code> — indefinida\n` +
          `<code>/pause N</code> — N días\n` +
          `<code>/pause force</code> — sin chequear\n` +
          `<code>/pause force N</code> — N días sin chequear`,
      );
      return;
    }
    pausedUntil = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  }

  setPaused(true, { pausedBy: chatId, pausedUntil });
  const expiraLine = pausedUntil
    ? `⏳ Expira: ${escapeHtml(formatPausedUntilAR(pausedUntil))}`
    : `⏳ Modo: manual (hasta <code>/resume</code>)`;
  const forceLine = force ? `\n⚡ Forzado (sin chequeo)` : '';
  await replyToChat(
    chatId,
    `⏸️ <b>Bot pausado</b>\n\n${expiraLine}${forceLine}\n🕒 ${escapeHtml(formatARShort())}`,
  );
  logger.info({ pausedUntil, pausedBy: chatId, force }, 'Bot pausado por comando Telegram');
};

const handleResume = async (chatId) => {
  const state = getState();
  if (!state.isPaused) {
    await replyToChat(chatId, `ℹ️ <b>El bot ya estaba activo</b>`);
    return;
  }
  setPaused(false);
  await replyToChat(
    chatId,
    `▶️ <b>Bot reanudado</b>\n\n🕒 ${escapeHtml(formatARShort())}`,
  );
  logger.info({ resumedBy: chatId }, 'Bot reanudado por comando Telegram');
};

const handleStatus = async (chatId) => {
  const state = getState();
  const paused = isPaused();
  const estadoLine = paused
    ? `⏸️ Estado: <b>pausado</b>${state.pausedUntil ? ` hasta ${escapeHtml(formatPausedUntilAR(state.pausedUntil))}` : ' (manual)'}`
    : `✅ Estado: <b>activo</b>`;
  const modoLine = config.dryRun
    ? `🧪 Modo: <b>DRY_RUN</b> (no clickea)`
    : `⚙️ Modo: <b>producción</b>`;
  const msg =
    `📊 <b>Estado del bot</b>\n\n` +
    `${estadoLine}\n` +
    `${modoLine}\n` +
    `🕒 ${escapeHtml(formatARShort())}\n\n` +
    `<b>Horarios programados</b>\n` +
    `🌅 Inicio · <code>${escapeHtml(humanizeCron(config.cron.start))}</code>\n` +
    `🌇 Fin · <code>${escapeHtml(humanizeCron(config.cron.end))}</code>\n` +
    `💚 Heartbeat · <code>${escapeHtml(humanizeCron(config.cron.heartbeat))}</code>`;
  await replyToChat(chatId, msg);
};

const handleHelp = async (chatId) => {
  await replyToChat(chatId, HELP_TEXT);
};

const dispatch = async (chatId, text) => {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(' ');
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const command = head.split('@')[0].toLowerCase();
  const args = rest.length > 0 ? rest.split(/\s+/) : [];

  switch (command) {
    case '/pause':
      await handlePause(chatId, args);
      break;
    case '/resume':
      await handleResume(chatId);
      break;
    case '/end-now':
    case '/endnow':
      await handleEndNow(chatId);
      break;
    case '/status':
      await handleStatus(chatId);
      break;
    case '/help':
    case '/start':
      await handleHelp(chatId);
      break;
    default:
      logger.debug({ command }, 'Comando desconocido — ignoro');
  }
};

const fetchUpdates = async ({ offset, timeoutSec, signal }) => {
  const url = new URL(telegramApi('getUpdates'));
  url.searchParams.set('timeout', String(timeoutSec));
  if (offset !== undefined && offset !== null) url.searchParams.set('offset', String(offset));
  url.searchParams.set('allowed_updates', JSON.stringify(['message']));

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    const err = new Error(`getUpdates HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`getUpdates not ok: ${JSON.stringify(data).slice(0, 200)}`);
    throw err;
  }
  return data.result;
};

export const startListener = async ({ signal } = {}) => {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    logger.warn('Telegram listener no arranca — falta token o chat_id');
    return;
  }

  let offset;
  try {
    const drain = await fetchUpdates({ offset: -1, timeoutSec: 0, signal });
    if (drain.length > 0) offset = drain[drain.length - 1].update_id + 1;
    logger.info({ offset: offset ?? null, drained: drain.length }, 'Listener Telegram arrancado (cola drenada)');
  } catch (err) {
    if (err.name === 'AbortError') return;
    logger.warn({ err: err.message }, 'Drain inicial falló — sigo igual');
  }

  let backoff = BACKOFF_MIN_MS;
  let stop = false;

  while (!stop && !signal?.aborted) {
    try {
      const updates = await fetchUpdates({ offset, timeoutSec: POLL_TIMEOUT_SEC, signal });
      backoff = BACKOFF_MIN_MS;

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || typeof msg.text !== 'string') continue;
        const fromChat = msg.chat?.id;
        if (Number(fromChat) !== authorizedChatId()) {
          logger.warn({ chatId: fromChat, text: msg.text.slice(0, 80) }, 'Comando ignorado — chat_id no autorizado');
          continue;
        }
        if (!msg.text.startsWith('/')) continue;
        try {
          await dispatch(fromChat, msg.text);
        } catch (err) {
          logger.warn({ err: err.message, text: msg.text }, 'dispatch lanzó');
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') break;

      if (err.status === 401 || err.status === 404) {
        logger.fatal({ status: err.status, err: err.message }, 'Token de Telegram inválido — listener detenido');
        stop = true;
        break;
      }

      if (err.status === 409) {
        logger.error({ err: err.message }, 'Conflict 409 — otra instancia está consumiendo updates, backoff 60s');
        await sleep(CONFLICT_BACKOFF_MS).catch(() => {});
        continue;
      }

      logger.warn({ err: err.message, backoffMs: backoff }, 'getUpdates falló — backoff');
      await sleep(backoff).catch(() => {});
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  logger.info('Listener Telegram cerrado');
};
