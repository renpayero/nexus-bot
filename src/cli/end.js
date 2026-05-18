import { logger } from '../logger.js';
import { endJornada } from '../jornada.js';
import { closeBrowser } from '../browser.js';

const force = process.argv.includes('--force');

const main = async () => {
  try {
    const result = await endJornada({ force });
    logger.info({ result }, 'endJornada terminó');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'endJornada lanzó excepción');
    process.exit(1);
  } finally {
    await closeBrowser();
  }
};

main();
