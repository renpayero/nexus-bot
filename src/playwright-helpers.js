import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { logger } from './logger.js';
import { sleep } from './utils.js';

export const firstVisible = async (page, group) => {
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

export const waitForVisible = async (page, group, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await firstVisible(page, group);
    if (found) return found;
    await sleep(500);
  }
  throw new Error(`${label}: no visible tras ${timeoutMs}ms`);
};

export const takeScreenshot = async (page, action, reason) => {
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
