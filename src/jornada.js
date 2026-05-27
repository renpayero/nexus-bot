import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { logger } from './logger.js';
import { getPage, refreshSession, isAuthLost } from './browser.js';
import { notify, notifyError } from './notifier.js';
import { sleep, jitter, formatARDate, formatARShort, escapeHtml } from './utils.js';

const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const MAX_SESSION_REFRESHES = 2;
const POST_CLICK_SETTLE_MS = 3_000;
const TRANSITION_TIMEOUT_MS = 15_000;
const MODAL_OPEN_TIMEOUT_MS = 15_000;
const MODAL_SUBMIT_ENABLE_TIMEOUT_MS = 5_000;

const SELECTORS = {
  startBtn: {
    roles: [
      (page) => page.getByRole('button', { name: /iniciar\s+jornada/i }),
    ],
    css: [
      'button:has-text("Iniciar Jornada")',
      'button:has-text("Iniciar jornada")',
      '[data-testid="start-jornada"]',
    ],
  },
  endBtn: {
    roles: [
      (page) => page.getByRole('button', { name: /finalizar\s+jornada/i }),
      (page) => page.getByRole('button', { name: /terminar\s+jornada/i }),
    ],
    css: [
      'button:has-text("Finalizar Jornada")',
      'button:has-text("Finalizar jornada")',
      'button:has-text("Terminar Jornada")',
      '[data-testid="end-jornada"]',
    ],
  },
  finishedText: {
    css: [
      'text=/ya finalizaste tu jornada/i',
      'text=/jornada finalizada/i',
    ],
  },
  modal: {
    container: {
      roles: [
        (page) => page.getByRole('dialog'),
      ],
      css: [
        '[role="dialog"]',
        'text=/reporte del d[ií]a/i',
      ],
    },
    submitBtn: {
      roles: [
        (page) => page.getByRole('button', { name: /enviar.*finalizar.*jornada/i }),
      ],
      css: [
        'button:has-text("Enviar y Finalizar Jornada")',
        'button:has-text("Enviar y finalizar jornada")',
      ],
    },
  },
};

const firstVisible = async (page, group) => {
  for (const builder of group.roles ?? []) {
    const loc = builder(page).first();
    try {
      if (await loc.isVisible({ timeout: 1_500 })) return { locator: loc, kind: 'role' };
    } catch {
      // ignore
    }
  }
  for (const sel of group.css ?? []) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1_500 })) return { locator: loc, kind: 'css', selector: sel };
    } catch {
      // ignore
    }
  }
  return null;
};

const waitForVisible = async (page, group, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await firstVisible(page, group);
    if (found) return found;
    await sleep(500);
  }
  throw new Error(`${label}: no visible tras ${timeoutMs}ms`);
};

const takeScreenshot = async (page, action, reason) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(paths.screenshots, `${stamp}_${action}_${reason}.png`);
    const buf = await page.screenshot({ fullPage: true });
    fs.writeFileSync(file, buf);
    logger.info({ file }, 'Screenshot guardado');
    return buf;
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudo tomar screenshot');
    return null;
  }
};

export const detectState = async (page) => {
  const response = await page.goto(config.nexus.flowUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const finalUrl = page.url();
  if (isAuthLost(finalUrl)) {
    const err = new Error('SESSION_EXPIRED');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  logger.debug({ finalUrl, status: response?.status() }, 'Cargué /flow');

  // SPA puede no haber renderizado todavía. Esperar hasta 10s a que aparezca
  // cualquier elemento accionable del bloque jornada antes de detectar.
  await page
    .locator('button:has-text("Iniciar Jornada")')
    .or(page.locator('button:has-text("Finalizar Jornada")'))
    .or(page.locator('text=/jornada finalizada/i'))
    .or(page.locator('text=/trabajando/i'))
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {
      logger.debug('Timeout esperando elemento accionable — sigo con detección');
    });

  await sleep(500);

  const endBtn = await firstVisible(page, SELECTORS.endBtn);
  if (endBtn) {
    logger.debug({ via: endBtn.kind, selector: endBtn.selector }, 'Detectado: in_progress (endBtn visible)');
    return 'in_progress';
  }

  const startBtn = await firstVisible(page, SELECTORS.startBtn);
  if (startBtn) {
    logger.debug({ via: startBtn.kind, selector: startBtn.selector }, 'Detectado: not_started (startBtn visible)');
    return 'not_started';
  }

  const finished = await firstVisible(page, SELECTORS.finishedText);
  if (finished) {
    logger.debug({ via: finished.kind, selector: finished.selector }, 'Detectado: finished (sin botones, solo texto)');
    return 'finished';
  }

  try {
    const html = await page
      .locator('text=/jornada laboral/i')
      .first()
      .locator('xpath=ancestor-or-self::*[contains(@class,"card") or contains(@class,"section") or self::section or self::div][1]')
      .innerHTML({ timeout: 2_000 })
      .catch(() => null);
    logger.warn({ url: finalUrl, htmlSnippet: html?.slice(0, 1200) }, 'Estado UNKNOWN — selectores no matchearon');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudo capturar HTML del bloque jornada');
  }
  return 'unknown';
};

const isAlreadyDone = (action, state) => {
  if (action === 'start') return state === 'in_progress';
  if (action === 'end') return state === 'not_started' || state === 'finished';
  return false;
};

const isReadyForAction = (action, state) => {
  if (action === 'start') return state === 'not_started' || state === 'finished';
  if (action === 'end') return state === 'in_progress';
  return false;
};

const isRetryableError = (msg) =>
  /timeout|net::|ERR_|navigation|networkidle|target closed|browser has been closed|STATE_UNKNOWN/i.test(msg);

const performStartFlow = async (page) => {
  const btn = await firstVisible(page, SELECTORS.startBtn);
  if (!btn) throw new Error('START_BTN_NOT_FOUND: botón "Iniciar Jornada" no visible antes del click');
  logger.info({ kind: btn.kind, selector: btn.selector }, 'Clickeando Iniciar Jornada');
  await btn.locator.click();

  await waitForVisible(page, SELECTORS.endBtn, TRANSITION_TIMEOUT_MS, 'START_TRANSITION_TIMEOUT: botón "Finalizar Jornada"');
  logger.info('Transición a in_progress confirmada');
};

const performEndFlow = async (page) => {
  const btn = await firstVisible(page, SELECTORS.endBtn);
  if (!btn) throw new Error('END_BTN_NOT_FOUND: botón "Finalizar Jornada" no visible antes del click');
  logger.info({ kind: btn.kind, selector: btn.selector }, 'Clickeando Finalizar Jornada');
  await btn.locator.click();

  const modal = await waitForVisible(
    page,
    SELECTORS.modal.container,
    MODAL_OPEN_TIMEOUT_MS,
    'MODAL_NOT_OPENED: modal "Reporte del día"',
  );
  logger.info({ kind: modal.kind, selector: modal.selector }, 'Modal abierto');

  const textareaLoc = page.locator('textarea').first();
  try {
    await textareaLoc.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    throw new Error('MODAL_TEXTAREA_NOT_FOUND: textarea del modal no visible');
  }

  const reportText = (config.endReportText && config.endReportText.trim()) || 'Tareas completadas exitosamente.';
  logger.info({ length: reportText.length }, 'Llenando textarea con reporte del día');
  await textareaLoc.fill(reportText);

  const submitBtn = await firstVisible(page, SELECTORS.modal.submitBtn);
  if (!submitBtn) throw new Error('MODAL_SUBMIT_NOT_FOUND: botón "Enviar y Finalizar Jornada" no visible');

  const enableDeadline = Date.now() + MODAL_SUBMIT_ENABLE_TIMEOUT_MS;
  let enabled = false;
  while (Date.now() < enableDeadline) {
    enabled = await submitBtn.locator.isEnabled().catch(() => false);
    if (enabled) break;
    await sleep(300);
  }
  if (!enabled) {
    throw new Error(`MODAL_SUBMIT_DISABLED: el botón "Enviar y Finalizar Jornada" sigue deshabilitado tras ${MODAL_SUBMIT_ENABLE_TIMEOUT_MS}ms. ¿La textarea no aceptó el texto?`);
  }

  logger.info({ kind: submitBtn.kind, selector: submitBtn.selector }, 'Clickeando Enviar y Finalizar Jornada');
  await submitBtn.locator.click();

  await waitForVisible(
    page,
    SELECTORS.startBtn,
    TRANSITION_TIMEOUT_MS,
    'END_TRANSITION_TIMEOUT: botón "Iniciar Jornada" no apareció tras enviar el reporte',
  );
  logger.info('Transición a not_started confirmada (modal cerrado + Iniciar Jornada visible)');
};

export const attemptAction = async ({ action, label, force = false }) => {
  const startedAt = Date.now();
  let sessionRefreshes = 0;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let page = null;
    try {
      page = await getPage();
      const state = await detectState(page);
      logger.info({ action, attempt, state }, 'Estado detectado');

      if (state === 'unknown' && !force) {
        const err = new Error('STATE_UNKNOWN: detección no encontró selectores accionables. Reintentando con backoff.');
        err.code = 'STATE_UNKNOWN';
        throw err;
      }

      if (isAlreadyDone(action, state) && !force) {
        const msg =
          `✅ <b>${escapeHtml(label)}</b>\n\n` +
          `ℹ️ Ya estaba completada\n` +
          `🔍 Estado: <code>${escapeHtml(state)}</code>\n` +
          `🕒 ${escapeHtml(formatARShort())}`;
        logger.info({ action, state }, 'Idempotente');
        await notify(msg);
        return { ok: true, idempotent: true, state };
      }

      if (!isReadyForAction(action, state) && !force) {
        const shot = await takeScreenshot(page, action, 'unexpected_state');
        await notifyError(
          `⚠️ <b>${escapeHtml(label)}</b>\n\n` +
            `🚨 Estado inesperado: <code>${escapeHtml(state)}</code>\n` +
            `ℹ️ No ejecuto la acción.\n` +
            `🕒 ${escapeHtml(formatARShort())}`,
          shot,
        );
        return { ok: false, unexpectedState: state };
      }

      const jitterMs = config.dryRun ? 0 : jitter(config.maxJitterSeconds);
      if (jitterMs > 0) {
        logger.info({ jitterSec: Math.round(jitterMs / 1000) }, 'Esperando jitter antes de clickear');
        await sleep(jitterMs);
      }

      if (config.dryRun) {
        if (action === 'start') {
          logger.info({ action, url: page.url() }, '[DRY_RUN] habría clickeado Iniciar Jornada');
          await notify(
            `🧪 <b>${escapeHtml(label)}</b> · DRY_RUN\n\n` +
              `<b>Habría hecho:</b>\n` +
              `1️⃣  Click en «Iniciar Jornada»\n` +
              `2️⃣  Esperar transición a <code>in_progress</code>\n\n` +
              `ℹ️ No se hizo nada.\n` +
              `🕒 ${escapeHtml(formatARShort())}`,
          );
        } else {
          const reportText = (config.endReportText && config.endReportText.trim()) || 'Tareas completadas exitosamente.';
          logger.info(
            { action, url: page.url(), reportText },
            '[DRY_RUN] habría clickeado Finalizar Jornada, llenado modal y enviado',
          );
          await notify(
            `🧪 <b>${escapeHtml(label)}</b> · DRY_RUN\n\n` +
              `<b>Habría hecho:</b>\n` +
              `1️⃣  Click en «Finalizar Jornada»\n` +
              `2️⃣  Esperar modal «Reporte del día»\n` +
              `3️⃣  Llenar textarea: <i>"${escapeHtml(reportText)}"</i>\n` +
              `4️⃣  Click «Enviar y Finalizar Jornada»\n` +
              `5️⃣  Esperar vuelta a <code>not_started</code>\n\n` +
              `ℹ️ No se hizo nada.\n` +
              `🕒 ${escapeHtml(formatARShort())}`,
          );
        }
        return { ok: true, dryRun: true };
      }

      if (action === 'start') {
        await performStartFlow(page);
      } else {
        await performEndFlow(page);
      }

      await sleep(POST_CLICK_SETTLE_MS);
      const newState = await detectState(page);
      const successStates = action === 'start' ? ['in_progress'] : ['not_started', 'finished'];
      if (successStates.includes(newState)) {
        const tookSec = Math.round((Date.now() - startedAt) / 1000);
        await notify(
          `✅ <b>${escapeHtml(label)}</b>\n\n` +
            `🔍 Estado final: <code>${escapeHtml(newState)}</code>\n` +
            `⏱️ Duración: ${tookSec}s\n` +
            `🕒 ${escapeHtml(formatARShort())}`,
        );
        logger.info({ action, tookSec, newState }, 'Acción completada');
        return { ok: true };
      }
      throw new Error(`POST_FLOW_STATE_MISMATCH: tras ${action} esperaba ${successStates.join('|')}, obtuve ${newState}`);
    } catch (err) {
      logger.error({ err: err.message, attempt, action }, 'Intento falló');

      if (err.code === 'SESSION_EXPIRED' || err.message === 'SESSION_EXPIRED') {
        if (sessionRefreshes >= MAX_SESSION_REFRESHES) {
          const shot = page ? await takeScreenshot(page, action, 'session_refresh_exhausted') : null;
          await notifyError(
            `❌ <b>${escapeHtml(label)}</b>\n\n` +
              `🔑 Sesión expirada\n` +
              `🚨 Refresh falló ${MAX_SESSION_REFRESHES} veces. Abortando.\n` +
              `🕒 ${escapeHtml(formatARShort())}`,
            shot,
          );
          return { ok: false, sessionRefreshFailed: true };
        }
        sessionRefreshes += 1;
        await notify(
          `🔑 <b>Sesión expirada</b>\n\n` +
            `🔄 Re-logueando (intento ${sessionRefreshes}/${MAX_SESSION_REFRESHES})...`,
        );
        try {
          await refreshSession();
          attempt -= 1;
          continue;
        } catch (refreshErr) {
          logger.error({ err: refreshErr.message }, 'refreshSession falló');
          if (sessionRefreshes >= MAX_SESSION_REFRESHES) {
            await notifyError(
              `❌ <b>${escapeHtml(label)}</b>\n\n` +
                `🔑 refreshSession falló\n` +
                `💬 <code>${escapeHtml(refreshErr.message)}</code>\n` +
                `🕒 ${escapeHtml(formatARShort())}`,
            );
            return { ok: false, sessionRefreshFailed: true };
          }
          continue;
        }
      }

      const retryable = isRetryableError(err.message);
      const shot = page ? await takeScreenshot(page, action, retryable ? 'retryable' : 'fatal').catch(() => null) : null;

      if (!retryable) {
        await notifyError(
          `❌ <b>${escapeHtml(label)}</b>\n\n` +
            `🚨 Error no recuperable\n` +
            `💬 <i>${escapeHtml(err.message)}</i>\n` +
            `🕒 ${escapeHtml(formatARShort())}`,
          shot,
        );
        return { ok: false, error: err.message };
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.info({ delayMs: delay, nextAttempt: attempt + 1 }, 'Reintentando con backoff');
        await sleep(delay);
        continue;
      }

      await notifyError(
        `❌ <b>${escapeHtml(label)}</b>\n\n` +
          `🚨 Falló tras ${RETRY_DELAYS_MS.length + 1} intentos\n` +
          `💬 <i>${escapeHtml(err.message)}</i>\n` +
          `🕒 ${escapeHtml(formatARShort())}`,
        shot,
      );
      return { ok: false, error: err.message, exhausted: true };
    }
  }

  return { ok: false, error: 'unreachable' };
};

export const startJornada = (opts = {}) =>
  attemptAction({
    action: 'start',
    label: 'Iniciar jornada',
    force: !!opts.force,
  });

export const endJornada = (opts = {}) =>
  attemptAction({
    action: 'end',
    label: 'Finalizar jornada',
    force: !!opts.force,
  });

export const getStatus = async () => {
  const page = await getPage();
  try {
    return await detectState(page);
  } finally {
    await page.close().catch(() => {});
  }
};
