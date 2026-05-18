import { logger } from '../logger.js';
import { refreshSession, closeBrowser } from '../browser.js';
import { paths } from '../config.js';

const main = async () => {
  logger.info('Ejecutando login bootstrap...');
  try {
    await refreshSession();
    logger.info({ path: paths.storageState }, '✅ Login OK, sesión guardada');
    console.log(`\nLogin OK, sesión guardada en ${paths.storageState}`);
    process.exit(0);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, '❌ Bootstrap falló');
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
};

main();
