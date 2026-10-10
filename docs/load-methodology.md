# Reproducible room-capacity measurement

The load client uses real guest-session HTTP requests, eight independent Socket.IO connections per room, and the normal durable MongoDB server path. It never reads secret engine state or bypasses gameplay checks. The benchmark is a measurement tool, not a precomputed capacity claim; publish the resulting JSON and the server/database hardware alongside any reported room count.

## Running a measurement

Use an isolated benchmark database. Enable `/api/metrics` on the game server with `ENABLE_METRICS=true`. Use the production game-server entrypoint, one authoritative server process, and a real MongoDB instance. The client can target the complete local stack at `http://localhost:3000`, or the game server directly on a separate port to isolate game-server capacity from Next.js rendering. Set the server's accepted `ORIGIN` to match the client's header.

For fast setup from a single load-generator IP, set server `HTTP_RATE=1000`, `SOCKET_CONNECTION_RATE=1000`, and `ROOM_CREATE_RATE=1000`. These raise session/join/room-creation limits only. Keep all drawing, points, chat, payload-size, queue, and per-turn history limits unchanged. These elevated setup values belong only to the isolated load environment.

```sh
BASE_URL=http://localhost:3000 pnpm load --rooms 5 --seconds 60 --output artifacts/load-5-screen.json
```

Run increasing room counts, for example 1, 5, 10, 20, then smaller increments near the first failure. Reset the isolated benchmark database and restart its server between runs so retained rooms and previous drawings cannot contaminate memory measurements. Do not reset a normal development or production database. Sustain the highest passing screening workload for at least ten minutes:

```sh
BASE_URL=http://localhost:3000 pnpm load --rooms 10 --seconds 600 --output artifacts/load-10-sustain.json
```

For a direct server on port 5000 whose configured origin is port 3000:

```sh
BASE_URL=http://localhost:5000 ORIGIN=http://localhost:3000 pnpm load --rooms 10 --seconds 600 --output artifacts/load-10-sustain.json
```

`--warmup` defaults to five seconds. `--one-way-delay-ms` defaults to 25. `LOAD_CPU_CORES` defaults to one and defines the CPU budget used for qualification; set it to the server's documented/enforced allocation, not the load-generator machine's total core count. `pnpm load --help` lists supported arguments. The harness writes a report after an interrupt, marking it incomplete. A nonzero exit indicates failed setup or no confirmed drawings; read the report's `criteria` and `passed` fields to judge performance, including successful runs that exceed a threshold.

## Workload

- Each room has eight distinct cookie sessions; the host starts after all eight receive authoritative snapshots.
- Rooms use ten rounds, 180-second drawings, and three custom words. The selected drawer receives its choices through its private socket message and chooses index zero. The game rotates drawers through normal server deadlines.
- Each active drawer sends 30 drawing batches per second, with eight integer-coordinate points per batch. Thirty batches form a one-second stroke. This stays below the 32-point workload ceiling and the real 64-point protocol ceiling. Using 32 points in every batch throughout a 180-second turn would exceed the unchanged 2 MiB drawing-history quota and measure intentional rejection instead of sustained service capacity.
- Every connected guesser submits one deliberately incorrect guess every five seconds. The client staggers guesses and measures their command acknowledgements.
- Every 45 seconds, one rotating guesser per room disconnects for one second and reconnects with its original cookie and room identity. The client waits for its new snapshot before considering that observer eligible for measured deliveries again.
- Setup and five-second warmup are excluded from command/latency totals. Measurement includes normal choosing/reveal transitions; achieved stroke rate is checked against time actually spent drawing. The harness does not conceal a slow client by sending catch-up bursts.

## Latency, delivery and errors

All independent client sessions run in one Node process and share a monotonic `performance.now()` clock. Command IDs map a drawer's creation/emission timestamps to observer `drawing` events. Observers deduplicate IDs. Fixed-size one-millisecond histograms keep memory bounded even with millions of deliveries.

The default 50 ms round trip is **application-emulated**, with an actual scheduled 25 ms delay before socket emission and another 25 ms delay before the observer or acknowledgement is recorded. It is not physical network shaping. The report includes both base latency (actual emit to receive) and end-to-end emulated latency (creation to delayed callback), with p50/p95/p99, mean, maximum, and sample counts. Timer scheduling overhead remains in the emulated measurement. This measures event delivery, not browser pixel presentation or input-to-paint latency.

Delivery ratio is unique observer events received divided by expected observer deliveries for confirmed drawing commands. A drawing is confirmed by a successful acknowledgement or an observed authoritative event. Expected observers are connected non-drawers at send time, excluding intentional reconnect windows. At the instant the harness deliberately disconnects an observer, it also removes that observer's still-undelivered expectation **only when the command acknowledgement is still pending**. Already-acknowledged missing events remain losses; unexpected disconnections never trigger this adjustment. Confirmed exclusions are reported explicitly as `totals.excludedDuringPlannedDisconnects`, alongside `expectedDeliveriesBeforePlannedExclusions` and `deliveryRatioBeforePlannedExclusions`, so the effect of the workload's deliberate disconnects remains visible.

An acknowledgement timeout or rejected command is counted separately as a command error; it never disappears from the error rate because some observers saw the event. Unexpected disconnections are recorded independently. Commands still in flight at the end receive up to their normal acknowledgement timeout before the report is finalized. The measurement loop never schedules a new reconnect at or after the requested end deadline; a 45-second screen therefore stops before its first periodic reconnect.

## Server measurements and qualification

Sample `/api/metrics` every five seconds and retain every sample in the JSON. Derive interval CPU consumption from cumulative process CPU microseconds, reporting percent of one logical core and percent of the configured CPU budget. Record resident memory, event-loop p95, interval mean durable database-write latency, cumulative maximum durable-write latency, and commit counts. Event-loop p95 is the server process's cumulative histogram, so it is not an isolated five-second percentile. Database latency covers journal writes in the actual acknowledgement path; it is not a standalone MongoDB throughput benchmark.

A qualifying sustained run requires all of:

- Complete setup and at least ten measured minutes.
- p95 observer delivery with emulated latency below 150 ms.
- Fewer than 1% rejected or timed-out commands, at least 99.9% expected deliveries, and no unexpected disconnections.
- At least 95% of the requested drawing rate while turns are in the drawing phase, with every room drawing for at least 90% of the measurement window (so failed starts cannot make the aggregate look healthy).
- p95 server CPU below 80% of the documented allocation.
- Last-third mean resident memory no more than `max(64 MiB, 25% of middle-third mean)` above the middle-third mean, allowing bounded canvas accumulation and garbage-collection variation.
- Metrics available throughout the run.

The report recommends `floor(highest passing sustained rooms × 0.70)` rooms, reserving 30% headroom. If any condition fails, it emits no recommended capacity. A short screening run cannot independently justify a production room count. The memory rule checks sustained drift on this workload, not a proof that no leak exists; inspect the retained time series as well.

## Reporting limitations

Record CPU model, logical cores, RAM, OS, Node/MongoDB versions, resource limits, database disk/storage type, deployment topology, commit hash, and the exact command. The JSON captures load-generator hardware and Node version; the operator must supply server/database details when they are on different machines. State explicitly when the generator, server, database, and UI share one computer: they compete for resources and do not model a dedicated production server.

Application delays do not simulate bandwidth, packet loss, jitter, congestion, cross-region latency, browser rendering, or mobile-device constraints. Run the three-browser acceptance scenario separately. The tested 180-second drawing duration and eight-player rooms form one workload profile; larger strokes, more frequent fills/undo, a different database disk, or different player counts require another measurement.
