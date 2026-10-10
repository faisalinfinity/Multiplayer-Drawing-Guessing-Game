import { buildServer } from './app.js';
const server = await buildServer({ mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/doodleroom' });
await server.app.listen({ port: Number(process.env.PORT || 4000), host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
