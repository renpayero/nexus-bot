import { logger } from '../logger.js';
import { getStatus } from '../jornada.js';
import { closeBrowser } from '../browser.js';

const main = async () => {
  try {
    const state = await getStatus();
    console.log(`\nEstado actual de la jornada: ${state}`);
    logger.info({ state }, 'jornada:status');
    process.exit(state === 'unknown' ? 1 : 0);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'status falló');
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
};

main();
