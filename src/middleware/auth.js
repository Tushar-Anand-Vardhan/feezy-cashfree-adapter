// src/middleware/auth.js
const { auth } = require('../firebaseClient');

async function verifyFirebaseToken(req, res, next) {
  console.log('🔥 AUTH MIDDLEWARE HIT');
  try {
    const authorization = (req.get('Authorization') || req.get('authorization') || '');
    if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
    const idToken = authorization.split(' ')[1];
    const decoded = await auth.verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', details: String(err) });
  }
}

module.exports = { verifyFirebaseToken };
