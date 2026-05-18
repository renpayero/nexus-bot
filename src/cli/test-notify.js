import { logger } from '../logger.js';
import { sendTelegram, sendEmail } from '../notifier.js';
import { escapeHtml, formatARDate } from '../utils.js';

const main = async () => {
  const stamp = formatARDate();
  const subject = `[NEXUS-BOT] Mensaje de prueba — ${stamp}`;
  const text = `🧪 <b>Mensaje de prueba desde nexus-bot</b>\n${escapeHtml(stamp)}`;
  const html = `<p>🧪 <strong>Mensaje de prueba desde nexus-bot</strong></p><p>${escapeHtml(stamp)}</p>`;

  logger.info('Enviando mensaje de prueba a Telegram...');
  const tg = await sendTelegram(text);
  logger.info({ tg }, 'Resultado Telegram');

  logger.info('Enviando mensaje de prueba por email...');
  const mail = await sendEmail(subject, html);
  logger.info({ mail }, 'Resultado email');

  const okTg = tg.ok;
  const okMail = mail.ok;

  if (okTg && okMail) {
    logger.info('✅ Ambos canales OK');
    process.exit(0);
  }
  logger.error({ telegram: tg, email: mail }, '❌ Algún canal falló');
  process.exit(1);
};

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'test-notify falló con excepción');
  process.exit(1);
});
