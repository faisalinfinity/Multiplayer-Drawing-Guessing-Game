# DoodleRoom

A browser drawing-and-guessing game for 2–12 friends. Create a room, share the link, and take turns drawing and guessing. Built with Next.js, TypeScript, a Node.js/Socket.IO game server, and MongoDB.

![DoodleRoom home screen](artifacts/home.png)

## Run with one command

You need **Docker Desktop running**, or Docker Engine with a recent Docker Compose v2 that supports `--wait`. Open a terminal in this repository's folder and run:

```sh
docker compose up --build -d --wait
```

When the command finishes successfully, open **[http://localhost:3000](http://localhost:3000)**. The first run needs internet access to download images and dependencies and can take several minutes. Later starts reuse the downloaded files.

This command builds and starts the frontend, game server, database, and gateway. You do **not** need to install Node.js, pnpm, or MongoDB, create an `.env` file, or provide any account or API keys for this local setup. The app keeps running after you close the terminal.

If port 3000 is occupied:

```sh
PORT=3100 ORIGIN=http://localhost:3100 docker compose up --build -d --wait
```

Then open [http://localhost:3100](http://localhost:3100). Keep `PORT` and `ORIGIN` in sync whenever you change the port.

To stop the app:

```sh
docker compose down
```

This keeps saved game data in Docker's database volume. Run the startup command again to restart. See [operations](docs/operations.md#docker-startup) for logs, troubleshooting, and deliberately resetting the database.

## Try a game with three players

1. Open the app in Chrome, enter a name, and create a room.
2. Click **Copy invite link**. Open that link in Brave and Safari and enter a different name in each browser.
3. In the host's browser, choose the number of rounds, drawing time, and word collection. If you change anything, click **Save settings**.
4. Once all three players appear, click **Let's get doodling** in the host's browser. The game only needs two players to start.
5. The drawer picks one of three words and draws. Switch to the other browsers to guess. After everyone has had their turns, the results page lets you replay each drawing.

Each player needs a separate browser or an isolated browser profile/private session. Normal tabs in the same profile share a player cookie, so opening another tab does not create a new player and can replace that player's existing connection. Multiple private windows may also share a private session; three different browsers are the simplest setup.

The default invite link works on the same computer. To invite people on other devices, follow the [network setup instructions](docs/operations.md#playing-from-another-device) and use an HTTPS address they can reach.

## What you can do

- The drawer chooses one of three private words. Everyone else guesses against a server-controlled timer, with letter hints and faster-guess bonuses.
- Draw with pen, colors, brush sizes, eraser, fill, undo, and clear. Keyboard shortcuts: **B** pen, **E** eraser, **F** fill, **Ctrl/Cmd+Z** undo.
- Correct answers become success announcements, and successful guessers cannot post spoilers. Near misses for answers with at least four characters receive private “close” feedback.
- Refresh or reconnect within 30 seconds to keep your score and seat. Late joiners see the current canvas, guess next turn, and draw starting next round. Host succession and drawer departure recover automatically.
- At game end, revisit every drawing with pause, seek, playback speed, and PNG download. Completed replays are retained for seven days.

## Deliverables and how it works

- [Canvas synchronization, authority, ordering, and restart behavior](docs/architecture.md)
- [Measured server capacity](docs/capacity.md) and [reproducible load methodology](docs/load-methodology.md)
- [Local development, deployment, persistence, and operations](docs/operations.md)
- [Private-room Skribbl.io reference study](docs/reference-study.md)
- [Validation evidence and abrupt-crash recovery drill](docs/validation.md)

Drawings travel as small batches of points, with the colour, brush size, and tool. The drawer sees each stroke straight away. The server checks and saves updates before sending them to everyone else. Numbered updates keep the canvas in order, and a fresh snapshot fills in missing data. The server also checks guesses, runs the timer, and awards points.

After a server restart, MongoDB restores saved scores and drawings. Players get 30 seconds to reconnect, and timers keep their original deadlines. The recorded capacity test passed with three rooms of eight players on a game server limited to two CPU cores and 1 GiB RAM, with MongoDB running separately. Start with two rooms per instance on that allocation to leave some headroom; [the capacity report](docs/capacity.md) explains the test and its limits.

Two known issues remain from the checklist review: very large custom word lists can exceed the socket message limit and disconnect the host, and answers shorter than four characters do not get “close” feedback. Use the built-in collection or a short custom list for now. The latency measurements cover delivery to clients; they do not prove that every browser paints every stroke without visible delay. See [validation](docs/validation.md) for the evidence and remaining gaps.

## Optional: develop and run checks

These steps are for working on the code. They are not needed to run the game with Docker. Use Node.js 24 LTS and pnpm 9.15.9. The [development guide](docs/operations.md#local-development-without-compose) covers their setup and gives separate MongoDB, game-server, and Next.js commands.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs lint, TypeScript, and unit tests. To include the real MongoDB/Socket.IO integration suite, provide a dedicated test MongoDB endpoint:

```sh
MONGO_TEST_URI=mongodb://127.0.0.1:27018/doodleroom_test pnpm check
```

After installing the test browsers as described in [operations](docs/operations.md#checks-browsers-and-load), run the browser checks against the app:

```sh
BASE_URL=http://localhost:3000 pnpm test:e2e
```

This checks independent Chrome, Firefox, and WebKit sessions plus a mobile layout. If you chose another port, change `BASE_URL` to match.

For a capacity test, follow the [isolated benchmark instructions](docs/load-methodology.md). The load harness creates real rooms and game data, so run it on its own test stack.

The deployment model is one authoritative game-server instance with durable storage. Capacity numbers apply to the measured workload and hardware; this repository does not implement multi-instance room sharding or high availability.
