// src/middleware/rawBody.js
// We'll use this function as `verify` option in express.json in server.js
function captureRawBody(req, res, buf) {
    req.rawBody = buf ? buf.toString() : '';
  }
  module.exports = { captureRawBody };
  