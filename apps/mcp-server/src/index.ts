import { createHttpServer } from './app.js';
import { readAuthSettings } from './auth.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const server = createHttpServer(readAuthSettings(process.env));
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.info(`HTTP service listening on port ${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
