'use strict';

/**
 * Email sender for dropshipper activation OTP — isolated from staff/ecomm auth controllers.
 * Uses same EMAIL_USER / EMAIL_PASSWORD SMTP env as other OTP flows.
 */

const nodemailer = require('nodemailer');
const { createDropshipperError } = require('./dropshipperHttp');
const logger = require('../../utils/logger');

let cachedTransporter = null;

function getMailTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const user = String(process.env.EMAIL_USER || '').trim();
  const pass = String(process.env.EMAIL_PASSWORD || '').trim();
  if (!user || !pass) {
    const err = createDropshipperError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Email transport not configured: set EMAIL_USER and EMAIL_PASSWORD'
    );
    throw err;
  }
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  return cachedTransporter;
}

function isEmailConfigured() {
  return Boolean(
    String(process.env.EMAIL_USER || '').trim() &&
      String(process.env.EMAIL_PASSWORD || '').trim()
  );
}

/**
 * @param {{ to: string, fullName?: string, otp: string, expiresMinutes?: number }} opts
 */
async function sendDropshipperActivationOtpEmail(opts) {
  const to = String(opts.to || '').trim().toLowerCase();
  const otp = String(opts.otp || '').trim();
  const fullName = String(opts.fullName || 'Dropshipper').trim();
  const expiresMinutes = Number(opts.expiresMinutes) || 10;

  if (!to || !otp) {
    throw createDropshipperError(400, 'VALIDATION_ERROR', 'Email and OTP are required for mail');
  }

  const from = String(process.env.EMAIL_USER || '').trim();
  const transporter = getMailTransporter();

  const subject = 'OWB Dropshipper — Activate your account (OTP)';
  const text = [
    `Hi ${fullName},`,
    '',
    'Your dropshipper registration was approved.',
    `Your activation OTP is: ${otp}`,
    '',
    `This code expires in ${expiresMinutes} minutes.`,
    'Do not share this code with anyone.',
    '',
    '— Offer Wale Baba Dropship'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your dropshipper registration was <strong>approved</strong>.</p>
      <p>Your activation OTP:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700">${otp}</p>
      <p>This code expires in <strong>${expiresMinutes} minutes</strong>. Do not share it.</p>
      <p style="color:#666">— Offer Wale Baba Dropship</p>
    </div>
  `;

  try {
    await transporter.sendMail({ from, to, subject, text, html });
  } catch (err) {
    logger.error('[dropshipperEmail] OTP send failed', {
      to,
      message: err?.message
    });
    throw createDropshipperError(
      502,
      'EMAIL_SEND_FAILED',
      'Failed to send activation OTP email. Please retry.'
    );
  }
}

module.exports = {
  isEmailConfigured,
  sendDropshipperActivationOtpEmail
};
