# Sangram Arena

A private, server-authoritative 1v1 medieval arena fighter that runs entirely in the browser.
Two warriors create or join a room with a six-character code, choose one of four fighters,
and duel with directional melee combat. The Go server owns the simulation; the browser only
sends inputs and renders snapshots.

```
Go 1.22+ ── HTTP + WebSocket ── HTML/Tailwind/Canvas client (embedded in the binary)
```

## Features

- **Private rooms** – six-character codes, nickname entry, reconnect tokens.
- **Four warriors** – Knight, Berserker, Duelist, Guardian (duplicates allowed).
- **Directional combat** – attack arcs, facing-based blocking, dodge with i-frames.
- **Lobby flow** – character select, confirm, ready, three-second countdown, rematch vote.
- **Authoritative netcode** – 60 Hz simulation, 30 Hz snapshots, client prediction for the
  local warrior and interpolation for the rival.
- **Follow camera** – smoothed tracking, arena clamping, off-screen rival indicator.
- **Desktop & mobile** – WASD / Space / Shift / E, or a virtual joystick with attack, block,
  and dodge buttons.
- **Grace & recovery** – a disconnected player keeps their seat for 12 seconds; the duel
  pauses and resumes on reconnect.

## Quick start

```bash
go run ./cmd/arena
# open http://localhost:8080
```

Open a second browser window (or another device on your network) and join with the room code.

### Configuration

| Variable          | Default | Description                                                        |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `PORT`            | `8080`  | HTTP/WebSocket port.                                               |
| `ALLOWED_ORIGINS` | –       | Comma-separated extra origins allowed to open a WebSocket.         |

`/api/config` exposes the active balance values, and `/api/health` reports room/player counts.

## Controls

| Action | Desktop            | Mobile              |
| ------ | ------------------ | ------------------- |
| Move   | `W A S D` / arrows | Virtual joystick    |
| Attack | `Space`            | Attack button       |
| Block  | `Shift` (hold)     | Block button (hold) |
| Dodge  | `E`                | Dodge button        |

Blocking suppresses attacks and dodges and slows movement; attacks also slow movement.
Dodging is brief, grants invulnerability, and has a cooldown shown on the HUD.

## Project layout

```
cmd/arena/            Entry point: config, listening, graceful shutdown
internal/game/        Pure deterministic simulation (config + match)
internal/room/        Room lifecycle, lobby state machine, manager
internal/ws/          WebSocket protocol, auth, rate limits, heartbeats
internal/server/      HTTP routes, static assets, security headers
web/                  Embedded client (HTML, CSS, JS modules, fonts)
  js/                 data, net, input, camera, renderer, audio, ui, main
```

### Simulation

All balance values live in `internal/game/config.go` (`DefaultConfig`). The match advances on
fixed 60 Hz ticks; the room broadcasts snapshots at 30 Hz. Attacks have per-character windup,
hit windows (20%–64% of the attack duration), range, arc, and cooldown. Movement is normalized
and clamped to the arena; facing is retained when the input direction is neutral.

### Protocol

JSON over WebSocket. Client → server: `hello`, `create`, `join`, `select`, `confirm`, `ready`,
`input`, `rematch`, `lobby`, `leave`, `ping`. Server → client: `welcome`, `room`, `state`,
`notice`, `error`, `session_lost`, `left`, `pong`. The first message must be `hello` carrying
the protocol version; combat input is rate-limited and validated against sequence numbers.

## Development

```bash
go test ./...        # simulation, room, and WebSocket integration tests
go vet ./...
```

Rebuild the compiled Tailwind stylesheet after changing markup or utility classes:

```bash
npx @tailwindcss/cli -c tailwind.config.js -i web/css/input.css -o web/css/tailwind.css --minify
# or, with the standalone binary:
tailwindcss -c tailwind.config.js -i web/css/input.css -o web/css/tailwind.css --minify
```

The arena art, fighters, portraits, and effects are drawn procedurally on canvas, so there are
no image assets to manage. Fonts are self-hosted in `web/fonts`.

## Deployment

Build a single static binary (the client is embedded):

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o arena ./cmd/arena
PORT=8080 ALLOWED_ORIGINS=https://example.com ./arena
```

Rooms are kept in memory, so run a single instance per set of rooms. Put a TLS-terminating
proxy in front for production WebSocket traffic (`wss://`).

## Acceptance checklist

- [x] Create a room, receive a six-character code, join from a second client.
- [x] Pick any of four warriors (duplicates allowed), confirm, ready, countdown.
- [x] Server-authoritative movement, attacks, blocks, dodges, and damage.
- [x] Winner/result screen, mutual rematch, decline to lobby, explicit leave awards the duel.
- [x] Disconnect grace, paused overlay, token-based reconnect.
- [x] Desktop keyboard and mobile joystick/touch controls.
- [x] Follow camera, arena clamping, off-screen rival indicator.
# sangram
# sangram
# sangram
