# lc0-maia communication API

Small HTTP API that talks to `lc0` over UCI and returns only the best move for a given FEN.

The engine call uses `go nodes 1` by default (as recommended for Maia-style play).
The server keeps a warm `lc0` process per Maia level, so requests do not restart the engine.
The runtime is Docker-based with container layout under `/opt/lc0`.

## Docker

The repo now includes a Docker setup that:

- builds `lc0` from source on Ubuntu 20.04
- downloads the full `maia-1100` through `maia-1900` net set published by the CSSLab `maia-chess` release artifacts
- defaults requests to level `1100`
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

You can change the default request level at build/run time:

```bash
MAIA_DEFAULT_LEVEL=1500 docker compose build
docker compose up
```

## Endpoints

- `GET /health` -> `{"ok": true, "defaultLevel": 1100, "availableLevels": [1100, ...]}`
- `POST /best-move` -> `{"bestMove":"e2e4","level":1500}`

Request body for `POST /best-move`:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "level": 1500
}
```

If `level` is omitted, the server uses `MAIA_DEFAULT_LEVEL` (or `1100` by default).

## Environment variables

- `PORT` (default: `8787`)
- `LC0_EAGER_INIT` (default: `false`; Docker sets this to `true` so the container fails fast if the engine cannot start)
- `MAIA_DEFAULT_LEVEL` (default: `1100`)
- `LC0_NODES` (default: `1`)
- `LC0_TIMEOUT_MS` (default: `30000`)
