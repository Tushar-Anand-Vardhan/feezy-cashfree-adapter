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
      cashfree: { merchant_id: merchantId, onboarding_status: cfResp?.data?.onboarding_status || 'CREATED', raw: cfResp },
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
    const { merchantId, userId, linkType, returnUrl } = req.body;
    let mId = merchantId;
    if (!mId && userId) {
      const udoc = await db.collection('users').doc(userId).get();
      mId = udoc.exists ? udoc.data()?.cashfree?.merchant_id : null;
    }
    if (!mId) return res.status(400).json({ error: 'merchantId or userId->merchant required' });

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

module.exports = router;
