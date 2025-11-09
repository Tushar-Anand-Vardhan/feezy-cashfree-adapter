// src/routes/debug.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { PARTNERS_BASE, PARTNER_KEY, API_VERSION } = require('../config');

router.get('/', (req, res) => res.send('ok'));
router.get('/health', (req, res) => res.send('ok'));
router.get('/merchant/:merchantId/status', async (req, res) => {
  try {
    const url = `${PARTNERS_BASE}/merchants/${req.params.merchantId}`;
    const resp = await axios.get(url, { headers: { 'x-partner-apikey': PARTNER_KEY, 'x-api-version': API_VERSION }});
    return res.json(resp.data);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
