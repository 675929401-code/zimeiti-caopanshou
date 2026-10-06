// Compatibility entrypoint. The versioned vNext file is the single PM2 source
// of truth for both Web (5000) and Voice Platform (5001).
module.exports = require("./deploy/pm2/ecosystem.vnext.config.cjs");
