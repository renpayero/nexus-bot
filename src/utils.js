export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const jitter = (maxSeconds) => {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return 0;
  return Math.floor(Math.random() * (maxSeconds * 1000 + 1));
};

const AR_FORMATTER_LONG = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const AR_FORMATTER_SHORT = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const formatARDate = (date = new Date()) => `${AR_FORMATTER_LONG.format(date)} ART`;

export const formatARShort = (date = new Date()) =>
  `${AR_FORMATTER_SHORT.format(date).replace(', ', ' · ')} ART`;

const DOW_LABELS = {
  '*': 'todos los días',
  '0-6': 'todos los días',
  '1-5': 'L a V',
  '0,6': 'sáb y dom',
  '6,0': 'sáb y dom',
  '6,7': 'sáb y dom',
  '0': 'domingos',
  '7': 'domingos',
  '1': 'lunes',
  '2': 'martes',
  '3': 'miércoles',
  '4': 'jueves',
  '5': 'viernes',
  '6': 'sábados',
};

export const humanizeCron = (expr) => {
  if (typeof expr !== 'string') return String(expr);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts;
  if (m === '*' && h === '*') return `cada minuto (${expr})`;
  if (dom !== '*' || mon !== '*') return expr;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return expr;
  const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  const days = DOW_LABELS[dow] ?? `días ${dow}`;
  return `${time} · ${days}`;
};

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export const escapeHtml = (input) => {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch]);
};
