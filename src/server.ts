import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local for production deployment (Next.js only auto-loads in dev mode)
config({ path: resolve(process.cwd(), '.env.local') });

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { startAutodlH3LifecycleWorkerFromEnvironment } from './lib/autodl-h3-lifecycle';
import { installAutodlH3ProductionRuntimeSafelyFromEnvironment } from './lib/autodl-h3-production-runtime';
import { shouldStartAutodlH3LifecycleWorker } from './lib/autodl-h3-runtime-start-gate';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );
    // Local/custom-server fallback. Production `next start` enters through
    // src/instrumentation.ts; the global singleton prevents duplicate loops.
    const installResult = installAutodlH3ProductionRuntimeSafelyFromEnvironment();
    if (shouldStartAutodlH3LifecycleWorker(installResult)) {
      startAutodlH3LifecycleWorkerFromEnvironment();
    }
  });
});
