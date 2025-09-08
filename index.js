// index.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

admin.initializeApp();
const db = admin.firestore();

const PARTNER_KEY = process.env.PARTNER_API_KEY; // store in Secret Manager
const CF_ENV = (process.env.CF_ENV || 'sandbox').toLowerCase(); // 'sandbox' or 'prod'
const API_VERSION = process.env.CF_API_VERSION || '2025-01-01';

// base URLs
const PARTNERS_BASE = CF_ENV === 'prod' ? 'https://api.cashfree.com/partners' : 'https://api-sandbox.cashfree.com/partners';
const PG_BASE       = CF_ENV === 'prod' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

if (!PARTNER_KEY) {
  console.error('MISSING PARTNER_API_KEY env var. Add it via Secret Manager.');
}

const app = express();

// capture rawBody for webhook signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString() : '';
  },
  limit: '1mb'
}));

// helper: verify Firebase id token (expects Authorization: Bearer <idToken>)
async function verifyFirebaseToken(req) {
  const auth = (req.get('Authorization') || req.get('authorization') || '');
  if (!auth.startsWith('Bearer ')) throw { status: 401, message: 'Missing Authorization header' };
  const idToken = auth.split(' ')[1];
  return admin.auth().verifyIdToken(idToken);
}

// helper: Cashfree request wrapper (partner)
async function cashfreePost(urlPath, jsonBody = {}, extraHeaders = {}) {
  const url = (urlPath.startsWith('http') ? urlPath : `${PARTNERS_BASE}${urlPath}`);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-version': API_VERSION,
    'x-partner-api-key': PARTNER_KEY,
    ...extraHeaders
  };
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(jsonBody) });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) {
    const err = new Error('Cashfree API error');
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data;
}

// endpoint: create a sub-merchant under partner (server-side)
app.post('/onboard', async (req, res) => {
  try {
    const auth = await verifyFirebaseToken(req);
    const { userId, merchantInfo } = req.body;
    if (!userId || !merchantInfo) return res.status(400).json({ error: 'userId and merchantInfo required' });

    // create merchant
    const cfResp = await cashfreePost('/merchants', merchantInfo);
    // cfResp.data.merchant_id expected per docs
    const merchantId = (cfResp?.data?.merchant_id) || cfResp?.merchant_id || null;

    // store mapping in users collection (your existing users schema)
    await db.collection('users').doc(userId).set({
      cashfree: {
        merchant_id: merchantId,
        onboarding_status: cfResp?.data?.onboarding_status || 'CREATED',
        raw: cfResp
      }
    }, { merge: true });

    // store the raw event for audit
    await db.collection('events').add({
      type: 'cashfree.onboard.created',
      userId, merchantId, cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/onboard error', err);
    return res.status(err.status || 500).json({ error: err.message || err, body: err.body || null });
  }
});

// endpoint: create embeddable onboarding link (merchant_id required OR userId to lookup)
app.post('/onboard/link', async (req, res) => {
  try {
    await verifyFirebaseToken(req);
    const { merchantId, userId, linkType } = req.body; // linkType: 'embeddable'|'standard'
    let mId = merchantId;
    if (!mId && userId) {
      const udoc = await db.collection('users').doc(userId).get();
      mId = udoc.exists ? udoc.data()?.cashfree?.merchant_id : null;
    }
    if (!mId) return res.status(400).json({ error: 'merchantId or userId->merchant required' });

    const endpoint = linkType === 'standard'
      ? `/merchants/${mId}/onboarding_link/standard`
      : `/merchants/${mId}/onboarding_link`; // embeddable default
    const cfResp = await cashfreePost(endpoint, {});

    // return link object to client, store it for auditing
    await db.collection('events').add({
      type: 'cashfree.onboard.link_created',
      merchantId: mId,
      cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/onboard/link error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || err });
  }
});

// endpoint: create subscription / UPI autopay (mandate)
// body: { userId, merchantId, enrollmentId, amount, intervalType:'MONTH', interval:1, customer_details:{name,phone,email}, return_url }
app.post('/mandate/create', async (req, res) => {
  try {
    await verifyFirebaseToken(req);
    const { userId, merchantId, enrollmentId, amount, intervalType = 'MONTH', interval = 1, customer_details, return_url, plan_id } = req.body;
    if (!merchantId || !userId || !enrollmentId || (!amount && !plan_id)) return res.status(400).json({ error: 'missing required params' });

    // build payload: use plan_id if provided, else provide plan_info inline
    const subscriptionId = `sub_${uuidv4()}`;
    const payload = {
      subscription_id: subscriptionId,
      customer_details: customer_details || {},
      authorization_details: { payment_methods: ['UPI'] },
      subscription_meta: { return_url: return_url || '' }
    };

    if (plan_id) {
      payload.plan_id = plan_id;
    } else {
      payload.plan_info = {
        plan_amount: amount,
        plan_interval_type: intervalType,
        plan_intervals: interval
      };
    }

    // call PG subscriptions endpoint - partner must pass x-partner-merchantid = merchantId
    const url = `${PG_BASE}/subscriptions`;
    const headers = {
      'x-api-version': API_VERSION,
      'x-partner-api-key': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'Content-Type': 'application/json',
      'x-idempotency-key': uuidv4()
    };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const cfResp = await resp.json();

    if (!resp.ok) {
      console.error('CF create subscription failed', cfResp);
      return res.status(500).json({ error: 'cashfree error', details: cfResp });
    }

    // store mandate doc in 'mandates' collection (new collection)
    await db.collection('mandates').doc(subscriptionId).set({
      subscription_id: subscriptionId,
      cf_response: cfResp,
      merchantId, userId, enrollmentId,
      status: cfResp?.subscription_status || 'INITIALIZED',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // write event
    await db.collection('events').add({
      type: 'cashfree.mandate.created',
      subscriptionId, merchantId, userId, enrollmentId, cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/mandate/create error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || err });
  }
});

// endpoint: cancel/modify subscription
// body: { merchantId, action: 'CANCEL' } action can be CANCEL / PAUSE / ACTIVATE
app.post('/mandate/:subscriptionId/manage', async (req, res) => {
  try {
    await verifyFirebaseToken(req);
    const { subscriptionId } = req.params;
    const { merchantId, action } = req.body;
    if (!merchantId || !action) return res.status(400).json({ error: 'merchantId and action required' });

    const url = `${PG_BASE}/subscriptions/${subscriptionId}/manage`;
    const headers = {
      'x-api-version': API_VERSION,
      'x-partner-api-key': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'Content-Type': 'application/json'
    };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action }) });
    const cfResp = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: 'cashfree error', details: cfResp });

    // update mandate doc status
    await db.collection('mandates').doc(subscriptionId).set({
      status: action === 'CANCEL' ? 'CANCELLED' : action,
      lastCfResponse: cfResp,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('events').add({
      type: 'cashfree.mandate.manage',
      subscriptionId, merchantId, action, cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/mandate/manage error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || err });
  }
});

// helper: verify CF webhook signature
function verifyCashfreeSignature(req) {
  try {
    const sigHeader = req.get('x-webhook-signature') || req.get('x-cashfree-signature');
    const ts = req.get('x-webhook-timestamp') || req.get('x-cashfree-timestamp');
    if (!sigHeader || !ts || !req.rawBody) return false;
    const hmac = crypto.createHmac('sha256', PARTNER_KEY);
    hmac.update(`${ts}.${req.rawBody}`);
    const expected = hmac.digest('base64');
    return expected === sigHeader;
  } catch (e) {
    console.error('verify signature error', e);
    return false;
  }
}

// webhook endpoint for Cashfree events (onboarding, subscription, payments, settlements, etc.)
app.post('/webhook', async (req, res) => {
  // ack fast
  res.status(200).send('ok');

  try {
    // verify signature
    const ok = verifyCashfreeSignature(req);
    if (!ok) {
      console.warn('Invalid CF webhook signature');
      await db.collection('events').add({
        type: 'cashfree.webhook.invalid_signature',
        headers: req.headers,
        raw: req.rawBody,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    const payload = req.body || {};
    // store raw webhook for audit
    await db.collection('events').add({
      type: `cashfree.webhook.${payload?.type || 'unknown'}`,
      payload,
      headers: {
        'x-webhook-timestamp': req.get('x-webhook-timestamp'),
        'x-webhook-signature': req.get('x-webhook-signature')
      },
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // handle merchant onboarding event
    if (payload.type === 'MERCHANT_ONBOARDING_STATUS' || payload.type === 'MERCHANT_ONBOARDING') {
      const mid = payload?.data?.merchant_id;
      const onboarding_status = payload?.data?.onboarding_status || payload?.data?.kyc_status;
      if (mid) {
        // find user where cashfree.merchant_id == mid
        const q = await db.collection('users').where('cashfree.merchant_id', '==', mid).limit(1).get();
        if (!q.empty) {
          const doc = q.docs[0];
          await doc.ref.set({ cashfree: { merchant_id: mid, onboarding_status } }, { merge: true });
        }
      }
    }

    // handle subscription-related events (status change or new payment)
    if (payload.type && payload.type.startsWith('SUBS')) {
      // many subscription webhook shapes exist; do best-effort mapping
      const subId = payload?.data?.subscription_id || payload?.data?.subscriptionId || payload?.data?.subscription?.id;
      const status = payload?.data?.status || payload?.data?.subscription_status;
      if (subId) {
        await db.collection('mandates').doc(subId).set({
          status,
          lastWebhook: payload,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      // if payment data present, create payment record in your payments collection (map to your existing schema)
      if (payload?.data?.payment_id || payload?.data?.cf_payment_id || payload?.data?.amount) {
        const paymentDoc = {
          source: 'cashfree',
          raw: payload.data,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('payments').add(paymentDoc);
      }
    }

    // generic payment success/fail events
    if (payload.type === 'PAYMENT_SUCCESS' || payload.event === 'PAYMENT_SUCCESS') {
      const p = payload?.data || payload;
      // create or update payment
      const doc = {
        source: 'cashfree',
        status: 'SUCCESS',
        amount: p?.amount || p?.data?.amount,
        cf_payment_id: p?.payment_id || p?.cf_payment_id || null,
        raw: p,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('payments').add(doc);
    } else if (payload.type === 'PAYMENT_FAILED' || payload.event === 'PAYMENT_FAILED') {
      const p = payload?.data || payload;
      await db.collection('payments').add({
        source: 'cashfree',
        status: 'FAILED',
        amount: p?.amount,
        cf_payment_id: p?.payment_id || null,
        raw: p,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // handle settlements & vendor-settlement events
    // store them in events collection (already done above). Your downstream jobs can pick them from events.
  } catch (e) {
    console.error('Error processing webhook', e);
    // we already replied 200 to Cashfree — it's okay: log for debugging
    await db.collection('events').add({
      type: 'cashfree.webhook.processing_error',
      error: String(e),
      raw: req.rawBody,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
});

// simple debug endpoints
app.get('/health', (req, res) => res.send('ok'));
app.get('/merchant/:merchantId/status', async (req, res) => {
  try {
    const url = `${PARTNERS_BASE}/merchants/${req.params.merchantId}`;
    const headers = { 'x-partner-api-key': PARTNER_KEY, 'x-api-version': API_VERSION };
    const resp = await fetch(url, { method: 'GET', headers });
    const json = await resp.json();
    return res.json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));
