import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { logger } from './logger.js';
import { getPage, refreshSession, isAuthLost } from './browser.js';
import { notify, notifyError } from './notifier.js';
import { sleep, jitter, formatARDate, escapeHtml } from './utils.js';

const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const MAX_SESSION_REFRESHES = 2;
const POST_CLICK_SETTLE_MS = 3_000;

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

  await sleep(1_500);

  const finished = await firstVisible(page, SELECTORS.finishedText);
  if (finished) {
    logger.debug({ via: finished.kind, selector: finished.selector }, 'Detectado: finished');
    return 'finished';
  }

  const endBtn = await firstVisible(page, SELECTORS.endBtn);
  if (endBtn) {
    logger.debug({ via: endBtn.kind, selector: endBtn.selector }, 'Detectado: in_progress');
    return 'in_progress';
  }

  const startBtn = await firstVisible(page, SELECTORS.startBtn);
  if (startBtn) {
    logger.debug({ via: startBtn.kind, selector: startBtn.selector }, 'Detectado: not_started');
    return 'not_started';
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

const isRetryableError = (msg) =>
  /timeout|net::|ERR_|navigation|networkidle|target closed|browser has been closed/i.test(msg);

export const attemptAction = async ({ action, fromState, toState, label, force = false }) => {
  const startedAt = Date.now();
  let sessionRefreshes = 0;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let page = null;
    try {
      page = await getPage();
      const state = await detectState(page);
      logger.info({ action, attempt, state }, 'Estado detectado');

      if (state === toState && !force) {
        const msg = `✅ <b>${escapeHtml(label)}</b>: ya estaba completada (idempotente)\n🕒 ${escapeHtml(formatARDate())}`;
        logger.info({ action }, 'Idempotente: ya estaba en estado destino');
        await notify(msg);
        return { ok: true, idempotent: true };
      }

      if (state !== fromState && !force) {
        const shot = await takeScreenshot(page, action, 'unexpected_state');
        await notifyError(
          `⚠️ <b>${escapeHtml(label)}</b>: estado inesperado <code>${escapeHtml(state)}</code>. No ejecuto acción.\n🕒 ${escapeHtml(formatARDate())}`,
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
        logger.info({ action, url: page.url() }, '[DRY_RUN] habría clickeado');
        await notify(`<b>${escapeHtml(label)}</b>: habría clickeado, no se hizo nada\n🕒 ${escapeHtml(formatARDate())}`);
        return { ok: true, dryRun: true };
      }

      const group = action === 'start' ? SELECTORS.startBtn : SELECTORS.endBtn;
      const btn = await firstVisible(page, group);
      if (!btn) throw new Error(`Botón ${action} no visible justo antes de clickear`);
      logger.info({ action, kind: btn.kind, selector: btn.selector }, 'Clickeando');
      await btn.locator.click();
      await sleep(POST_CLICK_SETTLE_MS);

      const newState = await detectState(page);
      if (newState === toState) {
        const tookSec = Math.round((Date.now() - startedAt) / 1000);
        await notify(
          `✅ <b>${escapeHtml(label)}</b>\n🕒 ${escapeHtml(formatARDate())}\n⏱️ Tomó ${tookSec}s`,
        );
        logger.info({ action, tookSec }, 'Acción completada');
        return { ok: true };
      }
      throw new Error(`POST_CLICK_STATE_MISMATCH: esperaba ${toState}, obtuve ${newState}`);
    } catch (err) {
      logger.error({ err: err.message, attempt, action }, 'Intento falló');

      if (err.code === 'SESSION_EXPIRED' || err.message === 'SESSION_EXPIRED') {
        if (sessionRefreshes >= MAX_SESSION_REFRESHES) {
          const shot = page ? await takeScreenshot(page, action, 'session_refresh_exhausted') : null;
          await notifyError(
            `❌ <b>${escapeHtml(label)}</b>: sesión expirada y refresh falló ${MAX_SESSION_REFRESHES} veces. Abortando.`,
            shot,
          );
          return { ok: false, sessionRefreshFailed: true };
        }
        sessionRefreshes += 1;
        await notify(`🔑 Sesión expirada (refresh ${sessionRefreshes}/${MAX_SESSION_REFRESHES}), re-logueando...`);
        try {
          await refreshSession();
          attempt -= 1;
          continue;
        } catch (refreshErr) {
          logger.error({ err: refreshErr.message }, 'refreshSession falló');
          if (sessionRefreshes >= MAX_SESSION_REFRESHES) {
            await notifyError(
              `❌ <b>${escapeHtml(label)}</b>: refreshSession falló: <code>${escapeHtml(refreshErr.message)}</code>`,
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
          `❌ <b>${escapeHtml(label)}</b>: error no recuperable\n<i>${escapeHtml(err.message)}</i>`,
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
        `❌ <b>${escapeHtml(label)}</b> falló tras ${RETRY_DELAYS_MS.length + 1} intentos\n<i>${escapeHtml(err.message)}</i>`,
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
    fromState: 'not_started',
    toState: 'in_progress',
    label: 'Iniciar jornada',
    force: !!opts.force,
  });

export const endJornada = (opts = {}) =>
  attemptAction({
    action: 'end',
    fromState: 'in_progress',
    toState: 'finished',
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
