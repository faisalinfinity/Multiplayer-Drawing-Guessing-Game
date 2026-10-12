FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
FROM base AS web-build
RUN pnpm --filter @doodle/web build
FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]
FROM base AS server-build
RUN pnpm --filter @doodle/server --prod deploy /server
FROM node:24-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=server-build --chown=node:node /server ./
USER node
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
