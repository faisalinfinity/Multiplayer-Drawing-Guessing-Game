import Fastify from 'fastify';
const app = Fastify({ logger: true });
app.get('/api/health', async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT || 4000), host: '0.0.0.0' });
