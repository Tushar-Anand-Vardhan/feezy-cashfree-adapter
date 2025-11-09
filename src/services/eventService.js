// src/services/eventService.js
const { db, FieldValue } = require('../firebaseClient');
async function logEvent(type, payload = {}) {
  await db.collection('events').add({ type, ...payload, createdAt: FieldValue.serverTimestamp() });
}
module.exports = { logEvent };
