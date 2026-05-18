import { logger } from '../logger.js';
import { startJornada } from '../jornada.js';
import { closeBrowser } from '../browser.js';

const force = process.argv.includes('--force');

const main = async () => {
  try {
    const result = await startJornada({ force });
    logger.info({ result }, 'startJornada terminó');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'startJornada lanzó excepción');
    process.exit(1);
  } finally {
    await closeBrowser();
  }
};

main();
