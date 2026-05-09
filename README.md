# lc0-maia communication API

Small HTTP API that talks to `lc0` over UCI and returns only the best move for a given FEN.

The engine call uses `go nodes 1` by default (as recommended for Maia-style play).

## Docker

The repo now includes a Docker setup that:

- builds `lc0` from source on Ubuntu 20.04
- downloads the `maia-1100.pb.gz` net published by the CSSLab `maia-chess` weights/release artifacts
- defaults to `maia-1100.pb.gz`
- serves the API on port `8787`

Start it with Docker Compose:

```bash
docker compose up --build
```

Then query it:

```bash
curl -s http://localhost:8787/best-move \
  -H "content-type: application/json" \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```

You can swap models later at build time:

```bash
MAIA_LEVEL=1500 docker compose build
docker compose up
```

## Endpoints

- `GET /health` -> `{"ok": true}`
- `POST /best-move` -> `{"bestMove":"e2e4"}`

Request body for `POST /best-move`:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
}
```

## Run

```bash
pnpm start
```

## Environment variables

- `PORT` (default: `8787`)
- `LC0_EAGER_INIT` (default: `false`; Docker sets this to `true` so the container fails fast if the engine cannot start)
- `LC0_BINARY` (default: `lc0`)
- `LC0_CWD` (default: current working directory, or directory containing `LC0_BINARY` if an absolute/relative path is used)
- `LC0_WEIGHTS` (optional; if unset, the app tries to auto-pick a `.pb.gz`/`.pb` file from `LC0_CWD`, preferring names with `maia`)
- `LC0_NODES` (default: `1`)
- `LC0_TIMEOUT_MS` (default: `30000`)

## Example for source-built lc0

If your binary and Maia net are in the same build directory:

```bash
export LC0_BINARY=/path/to/lc0/build/release/lc0
export LC0_CWD=/path/to/lc0/build/release
export LC0_WEIGHTS=/path/to/lc0/build/release/maia-1100.pb.gz
pnpm start
```

Then query:

```bash
curl -s http://localhost:8787/best-move \
  -H "content-type: application/json" \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}'
```
