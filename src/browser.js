import fs from 'node:fs';
import { chromium } from 'playwright';
import { config, paths } from './config.js';
import { logger } from './logger.js';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser = null;
let context = null;

const hasStoredSession = () => {
  try {
    return fs.existsSync(paths.storageState) && fs.statSync(paths.storageState).size > 0;
  } catch {
    return false;
  }
};

const createContext = async () => {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  const opts = {
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    bypassCSP: false,
  };
  if (hasStoredSession()) {
    opts.storageState = paths.storageState;
    logger.debug('Cargando storageState desde disco');
  } else {
    logger.warn('No hay storageState en disco — el contexto arranca sin sesión');
  }
  context = await browser.newContext(opts);
  return context;
};

export const getPage = async () => {
  if (!context) await createContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  return page;
};

export const saveSession = async () => {
  if (!context) throw new Error('No hay contexto activo para guardar sesión');
  await context.storageState({ path: paths.storageState });
  logger.info({ path: paths.storageState }, 'storageState guardado');
};

export const refreshSession = async () => {
  logger.info('Refrescando sesión: login programático');
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (!browser) browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    bypassCSP: false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);

  try {
    await page.goto(config.nexus.loginUrl, { waitUntil: 'domcontentloaded' });

    const emailLocator = page
      .locator('input[type="email"], input[name="email"], input[id="email"]')
      .first();
    await emailLocator.waitFor({ state: 'visible', timeout: 15_000 });
    await emailLocator.fill(config.nexus.email);

    const passLocator = page
      .locator('input[type="password"], input[name="password"], input[id="password"]')
      .first();
    await passLocator.waitFor({ state: 'visible', timeout: 10_000 });
    await passLocator.fill(config.nexus.password);

    const submitLocator = page
      .locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /ingresar|iniciar sesi[oó]n|entrar|login/i }))
      .first();

    await submitLocator.click();

    const errorMsg = page.locator('text=/credenciales incorrectas|invalid credentials|usuario o contrase|error/i').first();
    const navigated = page.waitForURL((url) => !/\/login|\/auth/i.test(url.toString()), { timeout: 20_000 });
    const errorAppeared = errorMsg.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'error');

    const result = await Promise.race([
      navigated.then(() => 'navigated'),
      errorAppeared,
    ]).catch((err) => {
      throw new Error(`LOGIN_TIMEOUT: ${err.message}`);
    });

    if (result === 'error') {
      const txt = await errorMsg.textContent().catch(() => '<sin texto>');
      throw new Error(`LOGIN_FAILED: Nexus rechazó credenciales — "${txt?.trim()}"`);
    }

    const finalUrl = page.url();
    if (/\/login|\/auth/i.test(finalUrl)) {
      throw new Error(`LOGIN_FAILED: URL final sigue en login: ${finalUrl}`);
    }

    await saveSession();
    logger.info({ finalUrl }, 'Login OK');
  } finally {
    await page.close().catch(() => {});
  }
};

export const closeBrowser = async () => {
  try {
    if (context) await context.close();
  } catch (err) {
    logger.warn({ err: err.message }, 'Error cerrando contexto');
  }
  try {
    if (browser) await browser.close();
  } catch (err) {
    logger.warn({ err: err.message }, 'Error cerrando browser');
  }
  context = null;
  browser = null;
};

export const isAuthLost = (url) => /\/login|\/auth/i.test(url);
