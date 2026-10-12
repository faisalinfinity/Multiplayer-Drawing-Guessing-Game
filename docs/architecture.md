# Technical note

## Authority and game flow

Next.js renders the browser application. A separate Fastify/Socket.IO server owns rooms, authentication, timers, guesses, scores, and accepted drawing commands. MongoDB stores recovery and replay data; Caddy serves the frontend, API, and sockets through one origin.

The engine advances `lobby → choosing → drawing → reveal → next turn → results`, waiting between turns when fewer than two players are connected. It automatically chooses after ten seconds, reveals hints at thirds of the drawing period, and scores by server receipt time. One correct guess awards `100 + floor(400 × remainingTime / drawTime)` to the guesser and 50 to the drawer in one persisted transition. Late joiners watch the current canvas, guess next turn, and draw next round.

Public state uses an explicit allowlist. Choices and the selected answer go only to the drawer; custom words go only to the lobby host. Built-in words stay in the server package. A modified client cannot submit scores or retrieve another player's private state. Correct guesses become success announcements without the raw answer. Drawer/successful-guesser chat stays locked until reveal. One-edit near misses receive private feedback for answers of at least four characters; shorter answers currently receive no near-miss feedback. Chat renders as text.

## Canvas synchronization and ordering

The board is an 800×600 logical raster. Pointer coordinates become bounded integer points; the drawer paints locally on the next animation frame and sends batches approximately every 33 ms, capped at 64 points. Commands contain a unique command ID, turn ID, stroke ID, chunk index, tool, color, brush size, and points. Fill, undo, and clear are ordered operations, not uploaded screenshots.

A shared deterministic renderer implements integer line drawing, brush masks, flood fill, and whole-action undo. The same code reconstructs live and replay pixels across browsers. The drawer overlays pending operations, removes them when authoritative events arrive, and rebuilds if rejected.

Each room has one serialized command queue. Validation and durable append happen before broadcast/acknowledgement. Journal entries have room-wide sequences; drawing events have consecutive per-turn sequences. Duplicate command IDs return the original acknowledgement. Clients ignore old drawing sequences and request a snapshot on gaps. Socket.IO ordering alone does not establish delivery or eliminate ambiguous acknowledgements.

Joining/resynchronizing runs through that same queue. The snapshot contains safe room state, the recipient's private state, the complete bounded current drawing history, and server time; subsequent events follow on the ordered connection. On acknowledgement timeout, the UI refreshes authoritative state instead of assuming success. Retrying an accepted command ID is safe, including after restart.

Local feedback avoids a network wait. Remote latency includes transit, validation/queueing, MongoDB durability, and browser rendering. [Measured capacity](capacity.md) and [load methodology](load-methodology.md) distinguish transport delivery from pixel presentation and application-emulated delay from real network shaping.

## Persistence, restart, and replay

MongoDB stores core-state transitions and separate drawing operations. Unique indexes on room/sequence and room/actor/command prevent duplicates. Writes request journaled majority acknowledgement; on standalone MongoDB, that is local durability rather than replicated redundancy. Periodic checkpoints optimize recovery, while the journal remains authoritative. After an uncertain write, the server checks its command ID and resynchronizes from committed data.

Restart loads the latest checkpoint/newer core state and current drawing history. All transports become offline, and saved players receive a fresh 30-second reconnect window. Their cookie restores identity and scores. Original deadlines remain: unexpired drawings resume; expired turns resolve once. An overdue choosing phase selects automatically and also resolves its drawing if that deadline passed. No next turn starts for phantom connections.

An ordinary disconnect reserves the seat for 30 seconds while the countdown continues. A returning drawer resumes control; explicit departure or grace expiry ends the turn. The earliest connected eligible member inherits a departed host's role. A return after grace is a fresh entrant. Storage/lease failures pause mutations and show a recovery state until committed state is reconciled. Acknowledged writes survive a server-process restart; lost database volumes require backups.

Completed-game effects supply replay metadata; participant-authorized endpoints return ordered operations, replayed with server timestamps and the shared renderer. Completed games expire after seven days. Sessions, checkpoints, and unfinished data use eight-day cleanup windows; abandoned live rooms expire after an hour. MongoDB TTL deletion is asynchronous.

## Operational boundaries

Opaque HttpOnly/SameSite session cookies are stored as hashes; HTTPS deployment adds Secure. The server verifies origin, membership, active socket ownership, privileges, turn IDs, schemas, and sizes. Limits include 200-character chat, two chat messages/second, 60 drawing batches/second, 64 points/4 KiB per batch, 8,192 points per stroke, 16 KiB packets, and 2 MiB drawing history per turn. Queues, points, expensive canvas actions, setup requests, and sync requests are bounded too.

A renewable MongoDB lease restricts normal operation to one authoritative process per database. Its 15-second database lifetime has a conservative 10-second monotonic usability window. Expiry or ownership loss permanently stops that runtime from accepting mutations; the production entrypoint exits and Docker starts a fresh process. This guard cannot transactionally fence a database write already in flight, so this deployment supports one replica and restart recovery, not overlapping failover or room sharding. Maintain database backups; see [operations](operations.md).
