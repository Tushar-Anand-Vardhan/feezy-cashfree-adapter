// index.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

admin.initializeApp();
const db = admin.firestore();

// ---------- Helpers for Cashfree subscription + Firestore persistence ----------

async function createCashfreeSubscription(merchantId, payload, idempotencyKey = uuidv4()) {
  const url = `${PG_BASE}/subscriptions`;
  const headers = {
    'x-api-version': API_VERSION,
    'x-partner-apikey': PARTNER_KEY,
    'x-partner-merchantid': merchantId,
    'Content-Type': 'application/json',
    'x-idempotency-key': idempotencyKey
  };

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err) {
    const e = new Error('Network error talking to Cashfree');
    e.cause = err;
    throw e;
  }
  // safe parse
  let cfResp;
  try {
    cfResp = await resp.json();
  } catch (e) {
    const text = await resp.text().catch(() => '<no-body>');
    const err = new Error('Invalid JSON from Cashfree');
    err.status = resp.status;
    err.body = text;
    throw err;
  }

  if (!resp.ok) {
    const err = new Error('Cashfree returned error');
    err.status = resp.status;
    err.body = cfResp;
    throw err;
  }

  return cfResp;
}

async function persistMandateRecord({
  localId,
  merchantSubId,
  cfSubId,
  cfResp,
  merchantId,
  userId,
  enrollmentId,
  status
}) {
  const docId = merchantSubId || cfSubId || localId || (`sub_${uuidv4()}`);
  const data = {
    local_id: localId || null,
    subscription_id: merchantSubId || null,       // merchant-provided id
    cf_subscription_id: cfSubId || null,          // cashfree internal id
    cf_response: cfResp || null,
    merchantId: merchantId || null,
    userId: userId || null,
    enrollmentId: enrollmentId || null,
    status: status || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection('mandates').doc(docId).set(data, { merge: true });
  return docId;
}

async function upsertMandateFromWebhook(subId, updates = {}) {
  if (!subId) throw new Error('subId required');

  const col = db.collection('mandates');

  // 1) Try direct doc read
  const directRef = col.doc(subId);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    await directRef.set({ ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return directRef.id;
  }

  // 2) Fallback query on subscription_id
  const q = await col.where('subscription_id', '==', subId).limit(1).get();
  if (!q.empty) {
    const doc = q.docs[0];
    await doc.ref.set({ ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return doc.id;
  }

  // 3) Fallback query on cf_subscription_id
  const q2 = await col.where('cf_subscription_id', '==', subId).limit(1).get();
  if (!q2.empty) {
    const doc = q2.docs[0];
    await doc.ref.set({ ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return doc.id;
  }

  // 4) Create a doc keyed by subId so further webhooks match quickly
  await col.doc(subId).set({
    subscription_id: subId,
    ...updates,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return subId;
}

const PARTNER_KEY = process.env.PARTNER_API_KEY; // store in Secret Manager
const CF_ENV = (process.env.CF_ENV || 'sandbox').toLowerCase(); // 'sandbox' or 'prod'
const API_VERSION = process.env.CF_API_VERSION || '2023-01-01'; 

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
    'x-partner-apikey': PARTNER_KEY,
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
app.get("/", (req, res) => {
  res.send("Cashfree adapter is live!");
});

// endpoint: create a sub-merchant under partner (server-side)
app.post('/onboard', async (req, res) => {
  try {
    console.log('PARTNER_KEY present?', PARTNER_KEY);
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
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp() // adding created and updated timestamps to users documents
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
    const { merchantId, userId, linkType, returnUrl } = req.body; 
    let mId = merchantId;

    if (!mId && userId) {
      const udoc = await db.collection('users').doc(userId).get();
      mId = udoc.exists ? udoc.data()?.cashfree?.merchant_id : null;
    }
    if (!mId) return res.status(400).json({ error: 'merchantId or userId->merchant required' });

    const endpoint = linkType === 'standard'
      ? `/merchants/${mId}/onboarding_link/standard`
      : `/merchants/${mId}/onboarding_link`;

    const payload = {
      type: "account_onboarding",   // required by Cashfree
      return_url: returnUrl || "https://feezy-cashfree-adapter-1253307878.asia-south1.run.app/onboard/link/callback"
    };

    const cfResp = await cashfreePost(endpoint, payload);

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

// link to which the onboarding api will re-direct
app.get('/onboard/link/callback', async (req, res) => {
  const { merchant_id } = req.query; // Cashfree may append params
  // You can now hit Cashfree API to fetch merchant onboarding status
  // Update Firestore user doc with status
  res.send("Onboarding complete. You may close this tab.");
});

// endpoint: create subscription / UPI autopay (mandate)
// body: { userId, merchantId, enrollmentId, amount, intervalType:'MONTH', interval:1, customer_details:{name,phone,email}, return_url }
app.post('/mandate/create', async (req, res) => {
  try {
    await verifyFirebaseToken(req);
    const { userId, merchantId, enrollmentId, amount, intervalType = 'MONTH', interval = 1, customer_details = {}, return_url, plan_id } = req.body;
    if (!merchantId || !userId || !enrollmentId || (!amount && !plan_id)) {
      return res.status(400).json({ error: 'missing required params' });
    }

    // generate local id and pass it as merchant subscription_id (Cashfree will store & return it)
    const localId = `sub_${uuidv4()}`;
    const payload = {
      subscription_id: localId,
      customer_details,
      authorization_details: { payment_methods: ['UPI'] },
      subscription_meta: { return_url: return_url || '' }
    };

    if (plan_id) payload.plan_id = plan_id;
    else payload.plan_info = { plan_amount: amount, plan_interval_type: intervalType, plan_intervals: interval };

    // call CF via helper (throws on non-200 / invalid JSON)
    const cfResp = await createCashfreeSubscription(merchantId, payload);

    // extract both ids (CF returns merchant subscription_id and cf_subscription_id per docs)
    const merchantSubId = cfResp?.data?.subscription_id || cfResp?.subscription_id || localId;
    const cfSubId = cfResp?.data?.cf_subscription_id || cfResp?.cf_subscription_id || null;
    const status = cfResp?.data?.subscription_status || cfResp?.subscription_status || 'INITIALIZED';

    // persist both ids; persistMandateRecord will choose doc id (merchantSubId preferred)
    const docId = await persistMandateRecord({
      localId,
      merchantSubId,
      cfSubId,
      cfResp,
      merchantId,
      userId,
      enrollmentId,
      status
    });

    // audit event
    await db.collection('events').add({
      type: 'cashfree.mandate.created',
      subscriptionId: docId,
      merchantId, userId, enrollmentId, cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      ok: true,
      subscription_id: merchantSubId,
      cf_subscription_id: cfSubId,
      local_id: localId,
      cfResp
    });
  } catch (err) {
    console.error('/mandate/create error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || String(err) });
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
      'x-partner-apikey': PARTNER_KEY,
      'x-partner-merchantid': merchantId,
      'Content-Type': 'application/json'
    };

    // call CF and safe-parse json
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action }) });
    let cfResp;
    try {
      cfResp = await resp.json();
    } catch (err) {
      const text = await resp.text().catch(()=>'<no-body>');
      console.error('manage: invalid JSON from Cashfree', resp.status, text);
      return res.status(502).json({ error: 'invalid response from cashfree', status: resp.status, body: text });
    }
    if (!resp.ok) {
      console.error('CF manage returned non-ok', resp.status, cfResp);
      return res.status(502).json({ error: 'cashfree error', status: resp.status, details: cfResp });
    }

    // update mandate doc status (try doc id; if not found, query fields)
    const targetId = subscriptionId;
    const direct = await db.collection('mandates').doc(targetId).get();
    if (direct.exists) {
      await direct.ref.set({
        status: action === 'CANCEL' ? 'CANCELLED' : action,
        lastCfResponse: cfResp,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const q = await db.collection('mandates').where('subscription_id', '==', targetId).limit(1).get();
      if (!q.empty) {
        await q.docs[0].ref.set({
          status: action === 'CANCEL' ? 'CANCELLED' : action,
          lastCfResponse: cfResp,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        const q2 = await db.collection('mandates').where('cf_subscription_id', '==', targetId).limit(1).get();
        if (!q2.empty) {
          await q2.docs[0].ref.set({
            status: action === 'CANCEL' ? 'CANCELLED' : action,
            lastCfResponse: cfResp,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          // create an index doc so subsequent webhooks/queries can match
          await db.collection('mandates').doc(targetId).set({
            subscription_id: targetId,
            status: action === 'CANCEL' ? 'CANCELLED' : action,
            lastCfResponse: cfResp,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
    }

    // audit event (optional)
    await db.collection('events').add({
      type: 'cashfree.mandate.manage',
      subscriptionId: targetId,
      merchantId,
      action,
      cfResp,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // **return success**
    return res.json({ ok: true, subscriptionId: targetId, cfResp });
  } catch (err) {
    console.error('/mandate/manage error', err);
    return res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});


// helper: verify CF webhook signature (timing-safe + timestamp tolerance)
function verifyCashfreeSignature(req) {
  try {
    const sigHeader = req.get('x-webhook-signature') || req.get('x-cashfree-signature');
    const tsHeader  = req.get('x-webhook-timestamp') || req.get('x-cashfree-timestamp');

    if (!sigHeader || !tsHeader || !req.rawBody) {
      // missing pieces
      return false;
    }

    // Accept both seconds and milliseconds timestamps.
    let tsNum = Number(tsHeader);
    if (Number.isNaN(tsNum)) return false;
    // if it's in ms (13+ digits), convert to seconds
    if (String(tsHeader).length > 10) tsNum = Math.floor(tsNum / 1000);

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > WEBHOOK_TOLERANCE_SEC) {
      // timestamp outside allowed window => possible replay
      return false;
    }

    // expected = Base64Encode( HMAC-SHA256( timestamp + "." + rawBody, PARTNER_KEY ) )
    const payload = `${tsHeader}.${req.rawBody}`;
    const expected = crypto.createHmac('sha256', PARTNER_KEY).update(payload).digest('base64');

    // timing-safe comparison
    const expectedBuf = Buffer.from(expected, 'utf8');
    const sigBuf = Buffer.from(sigHeader, 'utf8');
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
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
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
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
  // subscription webhook shapes vary; accept multiple id fields
  const subId = payload?.data?.subscription_id
              || payload?.data?.subscriptionId
              || payload?.data?.subscription?.id
              || payload?.data?.cf_subscription_id
              || payload?.data?.cfSubscriptionId
              || null;

  const status = payload?.data?.status || payload?.data?.subscription_status || null;

  if (subId) {
    try {
      await upsertMandateFromWebhook(subId, {
        status,
        lastWebhook: payload
      });
    } catch (e) {
      console.error('upsertMandateFromWebhook error', e);
      await db.collection('events').add({
        type: 'cashfree.webhook.upsert_error',
        error: String(e),
        subId,
        payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  // if payment data present, create payment record
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
    const headers = { 'x-partner-apikey': PARTNER_KEY, 'x-api-version': API_VERSION };
    const resp = await fetch(url, { method: 'GET', headers });
    const json = await resp.json();
    return res.json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 8080; 
app.listen(port, () => console.log('listening on', port));
