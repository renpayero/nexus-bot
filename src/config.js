import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const REQUIRED = [
  'NEXUS_EMAIL',
  'NEXUS_PASSWORD',
  'NEXUS_LOGIN_URL',
  'NEXUS_FLOW_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_TO',
  'TZ',
  'CRON_START',
  'CRON_END',
  'CRON_HEARTBEAT',
];

const missing = REQUIRED.filter((k) => !process.env[k] || String(process.env[k]).trim() === '' || String(process.env[k]).includes('__SET_IN_ENV__'));
if (missing.length > 0) {
  const msg = `Faltan variables de entorno obligatorias o tienen placeholder __SET_IN_ENV__: ${missing.join(', ')}. Revisá tu archivo .env (mirá .env.example).`;
  console.error(`[config] ${msg}`);
  process.exit(1);
}

const parseBool = (v, fallback = false) => {
  if (v === undefined || v === null) return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
};

const parseInt10 = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const paths = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  session: path.join(ROOT, 'data', 'session'),
  storageState: path.join(ROOT, 'data', 'session', 'storageState.json'),
  logs: path.join(ROOT, 'data', 'logs'),
  screenshots: path.join(ROOT, 'data', 'screenshots'),
};

export const config = {
  nexus: {
    email: process.env.NEXUS_EMAIL,
    password: process.env.NEXUS_PASSWORD,
    loginUrl: process.env.NEXUS_LOGIN_URL,
    flowUrl: process.env.NEXUS_FLOW_URL,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt10(process.env.SMTP_PORT, 587),
    secure: parseBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
    to: process.env.SMTP_TO,
  },
  dryRun: parseBool(process.env.DRY_RUN, true),
  tz: process.env.TZ,
  logLevel: process.env.LOG_LEVEL || 'info',
  maxJitterSeconds: parseInt10(process.env.MAX_JITTER_SECONDS, 90),
  cron: {
    start: process.env.CRON_START,
    end: process.env.CRON_END,
    heartbeat: process.env.CRON_HEARTBEAT,
  },
  env: process.env.NODE_ENV || 'production',
};
