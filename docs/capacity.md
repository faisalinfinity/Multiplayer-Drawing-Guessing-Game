# Measured capacity

**Recommend an initial limit of 2 rooms with 8 players each on the tested allocation.** Three rooms / 24 players passed a real ten-minute sustained run; `floor(3 × 0.70) = 2` reserves 30% room-count headroom. This is a measured workload recommendation, not a claim that the server's default 200-room admission ceiling is achievable.

Measured on 10 October 2026 using runtime commit `dcbef9cb37bce7c07e4be6f1fe07402b90456463`. [The sustained JSON](../artifacts/benchmarks/3-sustain.json) retains all samples, counters, thresholds, and verified image/environment metadata.

## Environment and workload

- **Game server:** Node.js 24.21.0, one process, Docker limit **2 CPU cores / 1 GiB RAM**.
- **Database:** MongoDB 8.0.32, separate Docker container limited to **2 CPU cores / 2 GiB RAM**, journaled writes to a persistent named volume.
- **Shared host:** Apple M4, 10 logical cores, 16 GiB RAM, macOS 26.6.2. Docker Desktop Engine 28.5.1 used a 10-core / approximately 7.65 GiB Linux VM. The load generator ran Node.js 25.5.0 on that same Mac. Server runtime remained Node.js 24.
- **Traffic:** eight authenticated Socket.IO sessions per room; one drawer sends 30 batches/second with eight points/batch; each guesser sends a wrong guess every five seconds. Every 45 seconds, one guesser per room disconnects for one second and reconnects. Normal 180-second drawings rotate through the game engine.

Each run used a fresh, isolated benchmark database, a five-second warmup, and `caffeinate -i` to prevent idle sleep. The client addressed the game server directly, bypassing Next.js/Caddy. A scheduled 25 ms delay in each direction **emulated** 50 ms network round trip; it did not physically shape a network. [Full methodology](load-methodology.md).

## Results

CPU below is p95 of five-second samples as a percentage of the **two-core allocation**. Latency includes the emulated network delay.

| Run | p95 / p99 observer latency | CPU p95 | Peak server RSS | Outcome |
| --- | --- | --- | --- | --- |
| [3 rooms, 60 seconds](../artifacts/benchmarks/3-screen.json) | 95 / 200 ms | 22.45% | 156.1 MiB | Screening thresholds passed |
| [5 rooms, 60 seconds](../artifacts/benchmarks/5-screen.json) | 319 / 1,000 ms | 36.69% | 169.9 MiB | Failed the 150 ms p95 target |
| [3 rooms, 600.055 seconds](../artifacts/benchmarks/3-sustain.json) | **68 / 112 ms** | **14.88%** | **205.2 MiB** | **All sustained criteria passed** |

The sustained run processed **55,337 commands**, including **52,838 confirmed drawing batches**, and measured **368,669 observer deliveries**. All expected eligible deliveries arrived. Eleven still-pending expectations were explicitly excluded when the harness deliberately disconnected their recipient; the unadjusted delivery ratio was **99.9970%**, also above the 99.9% requirement.

There were **12 `FORBIDDEN` rejections (0.02169%)**, coinciding with turn transitions, and no acknowledgement timeouts or unexpected disconnects. These rejections remain in the reported error rate. All **39 planned reconnects** ran. Drawing throughput reached **99.970%** of the requested rate during active drawing phases.

Without the emulated delay, observer p95/p99 were **15/58 ms**. With it, maximum observer latency was **614 ms**, so the passing percentile does not mean every update was instantaneous. Interval mean durable-write latency averaged **2.10 ms**. Mean RSS rose from **183.6 MiB** in the middle third to **195.7 MiB** in the final third, within the predefined 64 MiB allowance. Neither container restarted.

## Reproduce and interpret

Start only the isolated benchmark services with the checked-in allocation:

```sh
docker compose -p doodleroom-benchmark -f compose.yaml -f compose.benchmark.yaml up --build -d mongo server
```

After `/api/health` on port 5100 is healthy:

```sh
caffeinate -i env BASE_URL=http://localhost:5100 ORIGIN=http://localhost:5100 LOAD_CPU_CORES=2 pnpm load --rooms 3 --seconds 600 --output artifacts/benchmarks/reproduction.json
```

On systems without `caffeinate`, omit that prefix and prevent system sleep separately. Between comparisons, reset **only** this disposable project with `docker compose -p doodleroom-benchmark -f compose.yaml -f compose.benchmark.yaml down -v`. This deletes its benchmark database, never the normal `doodleroom` project.

Earlier failed screens using one-core limits and/or previous revisions remain in [the benchmark artifacts](../artifacts/benchmarks/); their filenames and embedded source/allocation metadata distinguish them. They are not used to claim final capacity. No 15-/20-room run was pursued after lower workloads failed the latency threshold.

This is a same-machine, Docker Desktop measurement with shared CPU, memory, and storage contention. It excludes browser painting, mobile-device cost, network loss/jitter, and proxy/frontend overhead; underlying disk performance was not isolated. Five-room screening demonstrated that low average CPU alone does not establish low latency. Re-measure on the intended production host and database, and for 12-player rooms or different drawing patterns, before raising the recommended admission limit.
