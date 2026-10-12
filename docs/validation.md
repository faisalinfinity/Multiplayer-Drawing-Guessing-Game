# Delivery validation

The delivered app was exercised through real browsers and a real MongoDB server; the game flow does not rely on mocked sockets or a database substitute. The table below records the earlier delivery run. A separate startup recheck is described below it.

| Check | Result |
| --- | --- |
| ESLint and workspace TypeScript checks | Passed |
| Engine, renderer, rate-limit and MongoDB integration tests | 61 passed, including 14 real-Mongo integration cases |
| Coordinated Chrome, Firefox and WebKit match | Passed: tools, private choices/feedback, score retention, late joins, rotation and results |
| Live drawing versus replay | Pixel-identical canvases for every completed drawing in the browser scenario |
| Mobile home/lobby and keyboard interaction | Passed at a 390-pixel viewport |
| Dropped drawing event and deliberately dropped first sync request | Recovered without refreshing the page |
| Clean-checkout production startup | Built and started with Docker Compose, then passed all three browser scenarios |
| Production dependency audit | No known vulnerabilities reported by `pnpm audit --prod` at delivery |

## One-command startup recheck — 12 October 2026

The exact README startup command was run successfully on the normal Docker Compose project:

```sh
docker compose up --build -d --wait
```

Both production images built successfully. MongoDB, the game server, the frontend, and the gateway started; the homepage returned HTTP 200 and `/api/health` returned `{"ok":true}` at `http://localhost:3000`. The existing database volume was preserved. The game is now served on port 3000. Existing Docker image and dependency caches were available.

An earlier check also started the same Compose file under a separate project name with a fresh MongoDB volume. That temporary project and its test database were removed after verification.

The default Compose configuration and `.env.example` were checked to point to the bundled MongoDB service. The isolated benchmark configuration was also checked with deliberately different inherited database, cookie, and room-limit settings; its own settings still took precedence.

The full `pnpm check` ran in a temporary Docker container with `MONGO_TEST_URI` set to the Compose MongoDB service. Lint, all workspace TypeScript checks, and **61 tests passed**, including all **14 real HTTP/Socket.IO/MongoDB integration cases**, with zero skipped. Each integration case used its own temporary database and removed only that database afterward. The application database was left intact.

`BASE_URL=http://localhost:3000 pnpm test:e2e` passed all **three browser scenarios in 28.6 seconds**: mobile layout, recovery from dropped drawing/sync messages, and a full Chrome/Firefox/WebKit match with private guesses, reconnects, a late joiner, and matching live/replay pixels. The replay-control check uses controlled browser time to verify play, pause, and seek reliably even for very short drawings.

## Known gaps from the checklist review

- Answers shorter than four characters do not receive near-miss feedback.
- Large custom word lists can pass validation but exceed the socket packet limit. Use the built-in collection or a short custom list until the limits are aligned.
- Latency benchmarks measure message delivery, not browser painting. Dedicated integration checks for each chat and drawing quota are still missing.

## Abrupt process crash

An isolated production Docker stack hosted three authenticated players. After a drawing operation and a scored correct guess, the actual game-server Node process was terminated with `SIGKILL`. Docker restarted the container automatically. Four startup attempts waited for the previous writer lease to expire.

All three original sessions recovered in **17.808 seconds**. Assertions verified the original room, turn, drawer-only word, canvas operation sequence, score and deadline. Retrying the accepted guess with its original command ID returned the original acknowledgement and did not award points twice. Observer and outsider connections did not receive the secret word.

This drill killed the process inside the container. A separate preliminary `docker kill` command was treated by Docker as an intentional stop and required an explicit start; it was not counted as evidence of automatic recovery.

## Reproduce

Use the commands in [operations](operations.md) and the committed tests in `apps/server/src`, `packages/shared/src`, and `e2e`. The real-Mongo tests require `MONGO_TEST_URI`; without it, those cases are explicitly skipped. GitHub Actions supplies MongoDB, builds the production images, and runs the browser suite.

Capacity is a separate sustained workload measurement. See [the capacity report](capacity.md) for resource allocations, successful and failed runs, latency, delivery, and measurement limits.
