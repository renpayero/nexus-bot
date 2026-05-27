import nodemailer from 'nodemailer';
import { config } from './config.js';
import { logger } from './logger.js';
import { escapeHtml, formatARDate } from './utils.js';

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporter;
};

const telegramApi = (method) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

export const sendTelegram = async (text, photoBuffer = null) => {
  try {
    if (photoBuffer) {
      const form = new FormData();
      form.append('chat_id', String(config.telegram.chatId));
      form.append('parse_mode', 'HTML');
      form.append('caption', text.slice(0, 1024));
      form.append('photo', new Blob([photoBuffer], { type: 'image/png' }), 'screenshot.png');
      const res = await fetch(telegramApi('sendPhoto'), { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        return { ok: false, error: `Telegram sendPhoto HTTP ${res.status}: ${body}` };
      }
      return { ok: true };
    }
    const res = await fetch(telegramApi('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      return { ok: false, error: `Telegram sendMessage HTTP ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

export const sendEmail = async (subject, htmlBody, attachments = []) => {
  try {
    const info = await getTransporter().sendMail({
      from: config.smtp.from,
      to: config.smtp.to,
      subject,
      html: htmlBody,
      attachments,
    });
    return { ok: true, id: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

export const notify = async (text) => {
  const result = await sendTelegram(text);
  if (!result.ok) logger.warn({ error: result.error }, 'Telegram notify falló — sigo igual');
  return result;
};

export const notifyError = async (text, screenshotBuffer = null) => {
  const tgResult = await sendTelegram(text, screenshotBuffer);
  if (!tgResult.ok) logger.warn({ error: tgResult.error }, 'Telegram notifyError falló');

  const stripHtml = (s) => s.replace(/<[^>]+>/g, '');
  const plainSubject = `[NEXUS-BOT] ❌ ${stripHtml(text).slice(0, 60)}`;
  const html = `
    <p><strong>Nexus Bot error</strong></p>
    <p>${text}</p>
    <hr>
    <p><small>${escapeHtml(formatARDate())}</small></p>
  `;
  const attachments = screenshotBuffer
    ? [{ filename: `screenshot_${Date.now()}.png`, content: screenshotBuffer, contentType: 'image/png' }]
    : [];
  const mailResult = await sendEmail(plainSubject, html, attachments);
  if (!mailResult.ok) logger.warn({ error: mailResult.error }, 'Email notifyError falló');

  return { telegram: tgResult, email: mailResult };
};
