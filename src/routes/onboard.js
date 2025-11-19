// src/routes/onboard.js
const express = require('express');
const router = express.Router();
const { cashfreePartnerPost } = require('../cashfree/subscriptionService');
const { db } = require('../firebaseClient');
const { verifyFirebaseToken } = require('../middleware/auth');
const { logEvent } = require('../services/eventService');

// POST /onboard
router.post('/', verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, merchantInfo } = req.body;
    if (!userId || !merchantInfo) return res.status(400).json({ error: 'userId and merchantInfo required' });

    const cfResp = await cashfreePartnerPost('/merchants', merchantInfo);
    const merchantId = (cfResp?.data?.merchant_id) || cfResp?.merchant_id || null;

    await db.collection('users').doc(userId).set({
      cashfree: { merchant_id: merchantId, onboarding_status: cfResp?.data?.onboarding_status || cfResp?.onboarding_status || 'CREATED', raw: cfResp },
      updatedAt: new Date()
    }, { merge: true });

    await logEvent('cashfree.onboard.created', { userId, merchantId, cfResp });

    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/onboard error', err);
    return res.status(err.status || 500).json({ error: err.message || String(err), body: err.body || null });
  }
});

// POST /onboard/link
router.post('/link', verifyFirebaseToken, async (req, res) => {
  try {
    console.log("code reached here");
    const { merchantId, userId, linkType, returnUrl } = req.body;
    let mId = merchantId;
    if (!mId && userId) {
      const udoc = await db.collection('users').doc(userId).get();
      mId = udoc.exists ? udoc.data()?.cashfree?.merchant_id : null;
    }
    if (!mId) return res.status(400).json({ error: 'merchantId or userId->merchant required' });
    console.log("code is here now", mId);
    const endpoint = linkType === 'standard' ? `/merchants/${mId}/onboarding_link/standard` : `/merchants/${mId}/onboarding_link`;
    const payload = { type: "account_onboarding", return_url: returnUrl || "" };
    const cfResp = await cashfreePartnerPost(endpoint, payload);

    await logEvent('cashfree.onboard.link_created', { merchantId: mId, cfResp });
    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('/onboard/link error', err);
    return res.status(err.status || 500).json({ error: err.message || err.body || err });
  }
});

// PATCH /onboard  (merchantId passed in body)
router.patch('/', verifyFirebaseToken, async (req, res) => {
  try {
    const { merchantId, updatePayload } = req.body;

    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId required in body' });
    }
    if (!updatePayload || Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'updatePayload required and must not be empty' });
    }

    const endpoint = `/merchants/${merchantId}`;
    const cfResp = await cashfreePartnerPost(endpoint, updatePayload, {
      'Content-Type': 'application/json',
      'x-api-version': '2023-01-01'
    });

    // Log event for audit (no Firestore update)
    await logEvent('cashfree.merchant.update_called', {
      merchantId,
      request: updatePayload,
      cfResp
    });

    return res.json({ ok: true, cfResp });
  } catch (err) {
    console.error('PATCH /onboard error', err);
    await logEvent('cashfree.merchant.update_failed', {
      error: err.message || String(err),
      body: err.body || null
    });
    return res.status(err.status || 500).json({
      error: err.message || String(err),
      body: err.body || null
    });
  }
});


module.exports = router;
