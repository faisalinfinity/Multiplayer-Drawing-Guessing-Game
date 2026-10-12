import { buildServer } from './app.js';
const server = await buildServer({ mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/doodleroom' });
await server.app.listen({ port: Number(process.env.PORT || 4000), host: '0.0.0.0' });
// A lost lease cannot be silently reacquired by this runtime. Docker restarts a fresh authority.
const authorityWatch = setInterval(() => {
  if (!server.store.hasLease()) { clearInterval(authorityWatch); void server.close().finally(() => process.exit(1)); }
}, 1000);
authorityWatch.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
