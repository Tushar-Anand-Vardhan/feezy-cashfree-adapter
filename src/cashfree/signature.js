// src/cashfree/signature.js
const crypto = require('crypto');
const { PARTNER_KEY, WEBHOOK_TOLERANCE_SEC } = require('../config');

function verifyCashfreeSignature({ headers, rawBody }) {
  try {
    if (!PARTNER_KEY) {
      console.error('Missing PARTNER_KEY / PARTNER_API_KEY env var for webhook verification');
      return false; // safe failure
    }
    const sigHeader = headers['x-webhook-signature'] || headers['x-cashfree-signature'];
    const tsHeader  = headers['x-webhook-timestamp'] || headers['x-cashfree-timestamp'];
    if (!sigHeader || !tsHeader || !rawBody) return false;

    let tsNum = Number(tsHeader);
    if (Number.isNaN(tsNum)) return false;
    if (String(tsHeader).length > 10) tsNum = Math.floor(tsNum/1000);
    const nowSec = Math.floor(Date.now()/1000);
    if (Math.abs(nowSec - tsNum) > WEBHOOK_TOLERANCE_SEC) return false;

    const payload = `${tsHeader}.${rawBody}`;
    const expected = crypto.createHmac('sha256', PARTNER_KEY).update(payload).digest('base64');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const sigBuf = Buffer.from(sigHeader, 'utf8');
    if (expectedBuf.length !== sigBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch (e) {
    console.error('signature verify error', e);
    return false;
  }
}

module.exports = { verifyCashfreeSignature };
