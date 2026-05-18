export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const jitter = (maxSeconds) => {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return 0;
  return Math.floor(Math.random() * (maxSeconds * 1000 + 1));
};

const AR_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export const formatARDate = (date = new Date()) => `${AR_FORMATTER.format(date)} ART`;

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export const escapeHtml = (input) => {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch]);
};
