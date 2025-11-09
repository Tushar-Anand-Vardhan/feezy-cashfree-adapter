// src/server.js
const express = require('express');
const { captureRawBody } = require('./middleware/rawBody');
const onboardRoutes = require('./routes/onboard');
const mandateRoutes = require('./routes/mandate');
const webhookRoutes = require('./routes/webhook');
const debugRoutes = require('./routes/debug');

const app = express();

// capture raw body before parsing to enable signature verification
app.use(express.json({ verify: captureRawBody, limit: '1mb' }));

app.use('/', debugRoutes);
app.use('/onboard', onboardRoutes);
app.use('/mandate', mandateRoutes);
app.use('/webhook', webhookRoutes);

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('listening on', port));
