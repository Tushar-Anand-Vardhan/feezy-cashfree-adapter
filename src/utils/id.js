// src/utils/id.js
const { v4: uuidv4 } = require('uuid');
module.exports = { uuid: () => uuidv4(), subLocalId: () => `sub_${uuidv4()}` };
