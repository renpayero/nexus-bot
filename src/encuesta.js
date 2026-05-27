import { config } from './config.js';
import { logger } from './logger.js';
import { notify, notifyError } from './notifier.js';
import { sleep, formatARShort, escapeHtml } from './utils.js';
import { firstVisible, waitForVisible, takeScreenshot } from './playwright-helpers.js';

const SURVEY_NAV_TIMEOUT_MS = 15_000;
const SURVEY_RENDER_TIMEOUT_MS = 10_000;
const SUBMIT_ENABLE_TIMEOUT_MS = 5_000;
const THANKS_TIMEOUT_MS = 15_000;
const FLOW_RELOAD_TIMEOUT_MS = 30_000;

const SURVEY_SELECTORS = {
  pendingBanner: {
    roles: [
      (page) => page.getByRole('button', { name: /completar\s+encuesta/i }),
      (page) => page.getByRole('link', { name: /completar\s+encuesta/i }),
    ],
    css: [
      'button:has-text("Completar Encuesta")',
      'a:has-text("Completar Encuesta")',
      'button:has-text("Completar encuesta")',
      'a:has-text("Completar encuesta")',
    ],
  },
  surveyTitle: {
    css: [
      'text=/encuesta de satisfacci[oó]n laboral/i',
      'text=/hola\\s+\\w+/i',
    ],
  },
  submitBtn: {
    roles: [
      (page) => page.getByRole('button', { name: /enviar\s+respuesta/i }),
    ],
    css: [
      'button:has-text("Enviar Respuesta")',
      'button:has-text("Enviar respuesta")',
    ],
  },
  thanksMessage: {
    css: [
      'text=/gracias por su respuesta/i',
      'text=/ya puedes cerrar esta pagina/i',
    ],
  },
};

const findQuestionContainer = (page, questionRegex) => {
  return page
    .getByText(questionRegex)
    .first()
    .locator(
      'xpath=ancestor-or-self::*[self::section or self::div or self::fieldset or contains(@class,"question") or contains(@class,"field")][1]',
    );
};

const clickNpsScale = async (page, questionRegex, value) => {
  const container = findQuestionContainer(page, questionRegex);
  try {
    await container.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    throw new Error(`SURVEY_QUESTION_NOT_FOUND: no encontré pregunta ${questionRegex} (timeout)`);
  }

  const exact = new RegExp(`^\\s*${value}\\s*$`);
  const strategies = [
    () => container.getByRole('button', { name: exact }).first(),
    () => container.locator('button').filter({ hasText: exact }).first(),
    () => container.locator(`button:has-text("${value}")`).first(),
  ];

  let lastErr = null;
  for (const make of strategies) {
    try {
      const btn = make();
      if (await btn.isVisible({ timeout: 1_500 })) {
        await btn.click({ timeout: 3_000 });
        logger.debug({ question: questionRegex.toString(), value }, 'NPS clickeado');
        return;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `SURVEY_NPS_CLICK_FAILED: no pude clickear "${value}" en pregunta ${questionRegex} (navigation timeout strategies agotadas)${lastErr ? ': ' + lastErr.message : ''}`,
  );
};

const clickStarRating = async (page, questionRegex, count) => {
  const container = findQuestionContainer(page, questionRegex);
  try {
    await container.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    throw new Error(`SURVEY_QUESTION_NOT_FOUND: no encontré pregunta de estrellas ${questionRegex} (timeout)`);
  }

  const strategies = [
    () => container.getByRole('button').nth(count - 1),
    () => container.getByRole('radio').nth(count - 1),
    () => container.locator(`[aria-label*="${count}"]`).first(),
    () => container.locator('svg').nth(count - 1),
    () => container.locator('button, [role="button"]').nth(count - 1),
  ];

  let lastErr = null;
  for (const make of strategies) {
    try {
      const star = make();
      if (await star.isVisible({ timeout: 1_500 })) {
        await star.click({ timeout: 3_000 });
        logger.debug({ question: questionRegex.toString(), count }, 'Estrella clickeada');
        return;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `SURVEY_STAR_CLICK_FAILED: no pude clickear ${count} estrellas en ${questionRegex} (navigation timeout estrategias agotadas)${lastErr ? ': ' + lastErr.message : ''}`,
  );
};

const waitForSubmitEnabled = async (submitLocator, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let enabled = false;
  while (Date.now() < deadline) {
    enabled = await submitLocator.isEnabled().catch(() => false);
    if (enabled) return true;
    await sleep(300);
  }
  return false;
};

const navigateToSurvey = async (page, bannerHit) => {
  const beforeUrl = page.url();
  let href = null;
  try {
    href = await bannerHit.locator.getAttribute('href', { timeout: 1_000 });
  } catch {
    // not an <a>, ok
  }

  if (href) {
    const absolute = href.startsWith('http') ? href : new URL(href, beforeUrl).toString();
    logger.info({ href: absolute }, 'Navegando a survey via href');
    await page.goto(absolute, { waitUntil: 'networkidle', timeout: SURVEY_NAV_TIMEOUT_MS });
    return;
  }

  logger.info('Clickeando "Completar Encuesta" (sin href, navigation por click)');
  await Promise.all([
    page.waitForURL(/\/survey\//, { timeout: SURVEY_NAV_TIMEOUT_MS }),
    bannerHit.locator.click(),
  ]);
};

export const checkAndCompleteSurvey = async (page) => {
  const banner = await firstVisible(page, SURVEY_SELECTORS.pendingBanner);
  if (!banner) {
    return { handled: false };
  }

  logger.info({ via: banner.kind, selector: banner.selector }, 'Encuesta pendiente detectada');
  await notify(
    `📋 <b>Encuesta pendiente detectada</b>\n\n` +
      `Completando antes de iniciar jornada...\n` +
      `🕒 ${escapeHtml(formatARShort())}`,
  );

  try {
    await navigateToSurvey(page, banner);
    const surveyUrl = page.url();
    logger.info({ surveyUrl }, 'En la página de la encuesta');

    await waitForVisible(
      page,
      SURVEY_SELECTORS.surveyTitle,
      SURVEY_RENDER_TIMEOUT_MS,
      'SURVEY_RENDER_TIMEOUT: el título de la encuesta no apareció',
    );

    await clickNpsScale(page, /recomiendes\s+GTC/i, 10);
    await clickStarRating(page, /satisfacci[oó]n\s+trabajando\s+con/i, 5);
    await clickStarRating(page, /supervisor.*calidad/i, 5);
    await clickNpsScale(page, /calificaci[oó]n\s+general/i, 10);

    const submitHit = await firstVisible(page, SURVEY_SELECTORS.submitBtn);
    if (!submitHit) {
      throw new Error('SURVEY_SUBMIT_NOT_FOUND: botón "Enviar Respuesta" no visible');
    }

    const enabled = await waitForSubmitEnabled(submitHit.locator, SUBMIT_ENABLE_TIMEOUT_MS);
    if (!enabled) {
      throw new Error(
        `SURVEY_SUBMIT_DISABLED: botón "Enviar Respuesta" sigue deshabilitado tras ${SUBMIT_ENABLE_TIMEOUT_MS}ms. Algún campo no se respondió (revisar selectores de NPS/estrellas).`,
      );
    }

    logger.info('Clickeando Enviar Respuesta');
    await submitHit.locator.click();

    await waitForVisible(
      page,
      SURVEY_SELECTORS.thanksMessage,
      THANKS_TIMEOUT_MS,
      'SURVEY_THANKS_NOT_SHOWN: no apareció "Gracias por su respuesta!" (timeout)',
    );
    logger.info('Encuesta enviada con éxito');

    await notify(
      `✅ <b>Encuesta completada</b>\n\n` +
        `🔗 <code>${escapeHtml(surveyUrl)}</code>\n` +
        `Reanudando inicio de jornada...\n` +
        `🕒 ${escapeHtml(formatARShort())}`,
    );

    await page.goto(config.nexus.flowUrl, { waitUntil: 'networkidle', timeout: FLOW_RELOAD_TIMEOUT_MS });
    await sleep(500);

    const stillThere = await firstVisible(page, SURVEY_SELECTORS.pendingBanner);
    if (stillThere) {
      const shot = await takeScreenshot(page, 'survey', 'banner_still_visible');
      await notifyError(
        `⚠️ <b>Encuesta enviada pero la alerta sigue visible en /flow</b>\n\n` +
          `Probablemente backend no actualizó. El retry del bot lo manejará.\n` +
          `🕒 ${escapeHtml(formatARShort())}`,
        shot,
      );
      throw new Error('SURVEY_BANNER_STILL_VISIBLE: la alerta sigue visible tras enviar (navigation pendiente)');
    }

    return { handled: true, surveyUrl };
  } catch (err) {
    const shot = await takeScreenshot(page, 'survey', 'failure').catch(() => null);
    await notifyError(
      `❌ <b>Encuesta falló</b>\n\n` +
        `💬 <i>${escapeHtml(err.message)}</i>\n` +
        `🕒 ${escapeHtml(formatARShort())}`,
      shot,
    );
    throw err;
  }
};
