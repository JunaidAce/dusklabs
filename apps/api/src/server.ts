import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

async function start() {
  const env = loadEnv();
  const { app } = await buildApp({ env });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
