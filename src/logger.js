import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config, paths } from './config.js';

fs.mkdirSync(paths.logs, { recursive: true });
fs.mkdirSync(paths.session, { recursive: true });
fs.mkdirSync(paths.screenshots, { recursive: true });

const isDev = config.env !== 'production';

const stdoutTarget = isDev
  ? {
      target: 'pino-pretty',
      level: config.logLevel,
      options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
    }
  : { target: 'pino/file', level: config.logLevel, options: { destination: 1 } };

const fileTarget = {
  target: 'pino-roll',
  level: config.logLevel,
  options: {
    file: path.join(paths.logs, 'app'),
    frequency: 'daily',
    extension: '.log',
    dateFormat: 'yyyy-MM-dd',
    mkdir: true,
  },
};

export const logger = pino({
  level: config.logLevel,
  base: { service: 'nexus-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [stdoutTarget, fileTarget],
  },
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const purgeOldLogs = () => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(paths.logs);
    let purged = 0;
    for (const f of files) {
      const full = path.join(paths.logs, f);
      const stat = fs.statSync(full);
      if (stat.isFile() && now - stat.mtimeMs > THIRTY_DAYS_MS) {
        fs.unlinkSync(full);
        purged += 1;
      }
    }
    if (purged > 0) logger.info({ purged }, 'Logs viejos borrados (>30d)');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudieron purgar logs viejos');
  }
};
