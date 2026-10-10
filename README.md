# DoodleRoom

A real-time drawing and guessing game for friends. Next.js + TypeScript, an authoritative Node.js/Socket.IO server, and MongoDB.

## Run

Install and start Docker Desktop, then run from this checkout:

```sh
docker compose up --build
```

Open http://localhost:3000. Create a room and share its link with other browsers. MongoDB data persists in a named Docker volume. No account or cloud credentials are required.

## Development

Node.js 24 LTS and pnpm 9.15.9 are the pinned toolchain. `pnpm install` installs all workspace dependencies; `pnpm check` runs lint, type checks, and unit/integration tests. Browser tests, the recording, and measured capacity notes are added in the delivery checkpoint.

## Reference and implementation

The [live reference study](docs/reference-study.md) records a private three-player Skribbl.io walkthrough and the intentional differences in this game. Implementation is tracked on `feat/multiplayer-drawing-game` in independently pushed checkpoints.
