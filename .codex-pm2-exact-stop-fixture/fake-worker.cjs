'use strict';
process.on('message', (message) => {
 if (message === 'shutdown') process.stdout.write("[MediaQueueWorker] stopped { reason: 'pm2-shutdown', drained: true }\n", () => process.exit(0));
});
setInterval(() => {}, 1000);
