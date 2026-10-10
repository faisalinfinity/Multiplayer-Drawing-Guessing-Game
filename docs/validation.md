# Delivery validation

The delivered app was exercised through real browsers and a real MongoDB server; the game flow does not rely on mocked sockets or a database substitute.

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
| Screen recording | Real Chrome/Firefox/WebKit; 120 seconds, 1920×1080 H.264, approximately 2.4 MiB |

## Abrupt process crash

An isolated production Docker stack hosted three authenticated players. After a drawing operation and a scored correct guess, the actual game-server Node process was terminated with `SIGKILL`. Docker restarted the container automatically. Four startup attempts waited for the previous writer lease to expire.

All three original sessions recovered in **17.808 seconds**. Assertions verified the original room, turn, drawer-only word, canvas operation sequence, score and deadline. Retrying the accepted guess with its original command ID returned the original acknowledgement and did not award points twice. Observer and outsider connections did not receive the secret word.

This drill killed the process inside the container. A separate preliminary `docker kill` command was treated by Docker as an intentional stop and required an explicit start; it was not counted as evidence of automatic recovery.

## Reproduce

Use the commands in [operations](operations.md) and the committed tests in `apps/server/src`, `packages/shared/src`, and `e2e`. The real-Mongo tests require `MONGO_TEST_URI`; without it, those cases are explicitly skipped. GitHub Actions supplies MongoDB, builds the production images, and runs the browser suite.

Capacity is a separate sustained workload measurement. See [the capacity report](capacity.md) for resource allocations, successful and failed runs, latency, delivery, and measurement limits.
