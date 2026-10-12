# Development and operations

## Docker startup

Install and start Docker Desktop, or use a running Docker Engine with Docker Compose v2 support. From the repository root, run this one command:

```sh
docker compose up --build -d --wait
```

Once the command finishes successfully, open [localhost:3000](http://localhost:3000). The first run needs internet access to download images and dependencies and can take several minutes. Docker builds the Next.js and game-server images, starts MongoDB, and routes browser traffic through Caddy. `-d` keeps the game running in the background; `--wait` waits for services to be running or healthy. You do not need Node.js, pnpm, a separate MongoDB installation, or an `.env` file for this path. Only the gateway is published to the host. MongoDB remains on the Compose network and stores data in the named `mongo-data` volume.

Create a room, copy its invite link, and open the link in two other browsers or independent browser profiles. Each player needs a separate cookie session; ordinary tabs in the same profile share one player identity. Chrome, Brave, and Safari can be used for a three-player game. The automated browser checks use Chrome, Firefox, and WebKit.

Check the running services and game-server health:

```sh
docker compose ps
curl --fail http://localhost:3000/api/health
docker compose logs --tail=100
```

Follow application logs with `docker compose logs -f server web gateway`. Pressing Ctrl+C stops following the logs and leaves the game running.

Use both a new gateway port and its matching allowed origin if port 3000 is occupied:

```sh
PORT=3100 ORIGIN=http://localhost:3100 docker compose up --build -d --wait
```

Then open [localhost:3100](http://localhost:3100) and use that port for health checks and browser tests. Keep both `PORT` and `ORIGIN` values together when recreating the stack. You can save them in a root `.env` file for repeated use.

Stop the game with `docker compose down`. This preserves the database volume; run the startup command again to bring it back. Use `docker compose restart server` for a controlled game-server restart, or rerun the startup command after a code change to rebuild the images. `docker compose down --volumes` deletes the database and should only be used when intentionally discarding rooms, sessions, and replays.

Configuration can be supplied through exported environment variables or a root `.env` file based on `.env.example`; the default local command requires neither. Exported shell variables take precedence over `.env` values. Inside Compose, `MONGODB_URI` must use the private service hostname, `mongodb://mongo:27017/doodleroom`, unless you deliberately configure an external database. A URI containing `localhost` or `127.0.0.1` points back to the game-server container, not the bundled MongoDB container. Do not copy the direct-development MongoDB URI below into the Compose configuration.

### Startup troubleshooting

- **Cannot connect to the Docker daemon:** start Docker Desktop or Docker Engine and wait until it is ready, then rerun the startup command. `docker info` confirms the daemon is reachable.
- **Unknown `--wait` option:** update to a current Docker Compose v2 release. `docker compose version` shows the installed version.
- **Port already allocated / address in use:** stop the process using port 3000, or use the matching `PORT=3100 ORIGIN=http://localhost:3100` command above.
- **Startup reports an unhealthy service or fails while waiting:** run `docker compose ps` and `docker compose logs --tail=100 mongo server web gateway`. Check for a stale `.env` or exported `MONGODB_URI`, insufficient Docker resources, or failed image downloads. After correcting the cause, rerun the startup command. Keep the database volume while investigating.
- **Page opens but joining fails:** check `/api/health`, ensure `ORIGIN` exactly matches the browser URL including its port, and use `localhost` consistently instead of switching between `localhost` and `127.0.0.1`.

### Playing from another device

`localhost` only works on the computer running Docker. To play from another computer or phone, serve the gateway at an HTTPS address that everyone can reach and that their browsers trust. Follow [production deployment](#production-deployment), set `ORIGIN` to that exact HTTPS address, and set `COOKIE_SECURE=true`. Everyone should open that address before creating or joining a room, so copied invitations use the right hostname.

Do not simply replace `localhost` with a plain HTTP LAN address. The browser features used for command IDs and copying invite links need a secure context. Browsers allow local development at `http://localhost`; other devices need HTTPS for this app.

## Local development without Compose

This optional path is for editing the code. Use Node.js 24 LTS and pnpm 9.15.9, and run the commands from the repository root:

```sh
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
```

Start a dedicated local MongoDB on port 27018, bound only to loopback. For example:

```sh
docker run --name doodleroom-dev-mongo --detach --publish 127.0.0.1:27018:27017 --volume doodleroom-dev-mongo:/data/db mongo:8.0
```

If that container already exists, use `docker start doodleroom-dev-mongo`. A locally installed MongoDB bound to `127.0.0.1:27018` works as well.

In one terminal, start the game server:

```sh
MONGODB_URI=mongodb://127.0.0.1:27018/doodleroom_dev ORIGIN=http://localhost:3100 PORT=4100 pnpm --filter @doodle/server dev
```

In a second terminal, start Next.js:

```sh
GAME_SERVER_URL=http://127.0.0.1:4100 NEXT_PUBLIC_SOCKET_URL=http://localhost:4100 pnpm --filter @doodle/web dev --port 3100
```

Open [localhost:3100](http://localhost:3100). Next.js forwards `/api` to `GAME_SERVER_URL`, while the browser connects directly to `NEXT_PUBLIC_SOCKET_URL` for sockets. Keep browser and socket hostnames consistent (`localhost` in this example) so the session cookie reaches both ports. `NEXT_PUBLIC_SOCKET_URL` is a browser build-time setting; leave it unset for the same-origin Compose/production gateway. The game server does not automatically load a development `.env` file, so export variables or prefix the command as shown.

The root `pnpm dev` command starts the web and server processes only; it does not start MongoDB or supply the separate ports and URLs above. Use the two explicit terminal commands for this setup. Stop each development process with Ctrl+C and stop its database with `docker stop doodleroom-dev-mongo` when finished.

## Checks, browsers, and load

After installing the optional local development dependencies above:

```sh
pnpm check
pnpm build
```

`check` runs ESLint, workspace TypeScript checks, and Vitest. Without `MONGO_TEST_URI`, database integration tests are explicitly skipped. Include them with a dedicated MongoDB endpoint:

```sh
MONGO_TEST_URI=mongodb://127.0.0.1:27018/doodleroom_test pnpm check
```

The integration suite creates a unique temporary database per test and drops that database afterward. It exercises actual Socket.IO connections and journaled writes, including authorization, reconnect, restart, oversized payloads, and uncertain-write recovery. CI provides its own MongoDB service.

Install Playwright browsers before browser acceptance tests. The local suite uses installed Google Chrome plus Playwright Firefox and WebKit; CI uses bundled Chromium:

```sh
pnpm exec playwright install chromium firefox webkit
```

Install Google Chrome locally if it is not already present, or run with `CI=1` to use bundled Chromium. On Linux, Playwright may also require system packages; `pnpm exec playwright install --with-deps chromium firefox webkit` installs them where supported.

Against the default Compose application that is already running:

```sh
BASE_URL=http://localhost:3000 pnpm test:e2e
```

Use `BASE_URL=http://localhost:3100` instead for the direct-development or alternate-port setup. This command does not start the application. The multiplayer browser scenario opens independent Chrome, Firefox, and WebKit sessions, plays a complete match, checks identical canvas pixels, reconnects a guesser, verifies late-join behavior, and compares replay to the finished drawing. The mobile scenario checks the home/lobby layout and keyboard interaction. Failed browser runs retain traces and screenshots under `test-results`; the HTML report is under `playwright-report`.

Capacity measurement is separate from browser acceptance. Follow [load methodology](load-methodology.md) to prepare an isolated database/server, enable metrics, raise only setup-specific limits, run the benchmark commands, reset between comparisons, and retain the JSON. Do not point the load generator at the normal application: it creates real rooms and events. [Capacity results](capacity.md) records measured hardware, outcomes, and headroom.

## Production deployment

Use one authoritative game-server instance. Keep browser HTTP and Socket.IO on the same public HTTPS origin through Caddy or an equivalent WebSocket-capable reverse proxy. The included `Caddyfile` listens on HTTP port 80 inside Compose for local startup; configure the real hostname and TLS at Caddy or a trusted upstream load balancer for production. Set `ORIGIN` to the exact public HTTPS origin and `COOKIE_SECURE=true`. Multiple explicit accepted origins can be comma-separated when required.

Keep the game server and database private. `TRUST_PROXY=true` is appropriate when only the trusted gateway can reach the server; direct public access would let clients spoof forwarding headers and undermine IP limits. Configure proxy WebSocket support and idle timeouts longer than the 10-second socket heartbeat interval. The Next.js image and game-server image run as the non-root `node` user.

Set `MONGODB_URI` to a durable MongoDB deployment. The bundled standalone MongoDB is sufficient for the local deliverable; a properly backed-up replica set or managed MongoDB deployment is recommended for production redundancy. The code requests `w: majority` and journaling; standalone majority acknowledgement cannot survive loss of that one machine or its volume. Use an authenticated, network-restricted database connection and keep credentials out of Git.

| Setting | Purpose / default |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI; Compose defaults to its private `mongo` service. |
| `ORIGIN` | Exact accepted browser origin; local default `http://localhost:3000`. |
| `COOKIE_SECURE` | Set `true` behind public HTTPS; local HTTP default `false`. |
| `PORT` | Compose gateway host port; direct Node process listen port when set on that process. |
| `GAME_SERVER_URL` | Next.js server-side HTTP API destination in direct development. |
| `NEXT_PUBLIC_SOCKET_URL` | Direct-development browser socket URL; unset behind the same-origin gateway. |
| `TRUST_PROXY` | Trust forwarding headers only from an isolated trusted proxy path. |
| `MAX_ROOMS` | Admission ceiling, default 200; set according to measured capacity, not the default alone. |
| `ENABLE_METRICS` | Enables `/api/metrics` only when `true`; disabled by default. |
| `HTTP_RATE`, `SOCKET_CONNECTION_RATE` | Setup requests/connections per second per IP; default 5, burst six times the rate. |
| `ROOM_CREATE_RATE` | Room creations per minute per IP, default 5 with a burst of 5. |

The last three rate settings are raised only for an isolated benchmark generator sharing one IP. Keep the normal service's protection enabled. Gameplay stroke/chat/point/action limits stay unchanged during benchmark runs.

## Health, recovery, and retention

`GET /api/health` returns 503 when the server is closing, storage is unavailable, the writer lease is unhealthy, or a room is recovering. Monitor this endpoint, process restarts, database write latency, queue pressure, disk space, and memory. When enabled, `/api/metrics` exposes room/connection counts, process memory/CPU, command counters, event-loop p95, and database-write measurements. It has no independent authentication: keep it on an operator-only network or explicitly block/authenticate that path at the public gateway. Allowed-origin checks are not access control for non-browser clients.

SIGTERM/SIGINT shutdown drains room queues, closes sockets and HTTP, and releases the database lease. An abrupt kill may leave its lease for up to 15 seconds; allow the next process to retry after expiration. A runtime whose conservative monotonic lease deadline expires rejects further mutations and exits; the supplied Docker restart policy then starts a fresh authority. This local guard is not transactional fencing for already-issued database writes. Do not run rolling overlap or multiple game-server replicas against the same database. This design provides restart recovery, not high availability.

Restarting the game server reconstructs recently active rooms from MongoDB. Players receive a fresh 30-second window to reconnect with their existing cookie; saved scores and accepted strokes remain. Timers retain their original deadlines, and expired turns resolve before play resumes. During a storage outage, changes pause until the journal can be reconciled; do not delete data or reset the database to clear a recovery state.

Use `docker compose restart server` for a controlled restart. Docker's explicit stop/kill commands can suppress automatic restarts; the [crash drill](validation.md) tested an unexpected Node process exit separately.

Completed replays expire after seven days. Sessions, checkpoints, and unfinished data have eight-day cleanup windows; live abandoned rooms expire after an hour. MongoDB TTL cleanup is asynchronous. Room expiration does not immediately erase its retained replay documents.

Back up MongoDB, not just application containers. Use the database provider's consistent snapshot/backup mechanism, define retention, and test a restore into an isolated database. For a standalone local backup, stop the game-server writer while taking a database backup so the journal and checkpoints form a coherent recovery source. Keep the named Docker volume across normal upgrades. A volume deletion, disk failure, or expired retention window cannot be repaired by restarting Node.js.
