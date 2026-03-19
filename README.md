# PCM - Personal Crypto Messenger

Desktop E2E messenger built with Electron, React, Fastify, SQLite/libSQL, and mediasoup.

## Stack

- `client/`: Electron + React desktop app
- `server/`: Fastify API + WebSocket signaling + mediasoup SFU
- `shared/`: shared TypeScript protocol types and constants
- Database: SQLite via libSQL client and Drizzle ORM

## Prerequisites

- Node.js 20+
- npm workspaces enabled
- Linux VPS for server deployment
- Open TCP `80/443` and UDP `SFU_MIN_PORT-SFU_MAX_PORT` on the VPS

## Install

```bash
npm install
npm run build:shared
```

## Development

```bash
# server
npm run dev:server

# desktop client
npm run dev:client

# named client profiles
npm run dev:alice
npm run dev:bob

# quick multi-process setups
npm run dev:all
npm run dev:3
```

## Validation

```bash
npm run typecheck
npm test --workspaces --if-present
npm run build
```

## Runtime Configuration

### Server

- `JWT_SECRET`: required outside `development` and `test`; must not use the example value
- `PORT`: HTTP port, default `3001`
- `HOST`: bind host, default `0.0.0.0`
- `DATABASE_PATH`: SQLite file path, default `./data/pcm.db`
- `UPLOAD_DIR`: upload storage path, default `./uploads`
- `CORS_ORIGIN`: comma-separated allowed origins; required in production
- `MAX_FILE_SIZE`: upload limit in bytes, default `104857600`
- `LOG_LEVEL`: pino log level, default `info`
- `SFU_LISTEN_IP`: mediasoup listen IP, default `0.0.0.0`
- `SFU_ANNOUNCED_IP`: public IP announced to mediasoup clients; required for public VPS media traffic
- `SFU_MIN_PORT`: mediasoup UDP min port, default `20000`
- `SFU_MAX_PORT`: mediasoup UDP max port, default `30000`

Use [server/.env.example](/c:/zaop/PCM/server/.env.example) as a template. Do not commit a real `.env`.

### Desktop Client

- The login/register screen accepts a `Server URL`
- The last successful server URL is persisted locally and reused after logout/login
- Development still defaults to `http://localhost:3001`

## Production Build

```bash
npm run build:shared
npm run build:server
npm run build:client
```

Server entrypoint:

```bash
cd server
node dist/index.js
```

## VPS Deployment

### Reverse Proxy

Use [deploy/nginx/pcm.conf.example](/c:/zaop/PCM/deploy/nginx/pcm.conf.example) as the baseline.

Requirements:

- Proxy `/health`, `/auth/*`, `/api/*`, and `/ws`
- Enable WebSocket upgrade headers on `/ws`
- Keep `client_max_body_size` aligned with `MAX_FILE_SIZE`
- Terminate TLS at nginx

### systemd

Use [deploy/systemd/pcm.service.example](/c:/zaop/PCM/deploy/systemd/pcm.service.example) as the baseline.

Recommended layout:

- app code under `/opt/pcm`
- environment file at `/etc/pcm/server.env`
- dedicated `pcm` user and group

### Firewall

Open:

- TCP `80` and `443` for nginx
- UDP `SFU_MIN_PORT-SFU_MAX_PORT` for mediasoup

Without the UDP range and correct `SFU_ANNOUNCED_IP`, calls may fail even if HTTP and WebSocket work.

## SQLite And Upload Backups

- Back up `DATABASE_PATH` with SQLite-aware tooling such as `sqlite3 .backup`
- Back up `UPLOAD_DIR` separately
- Include WAL files during backup windows if WAL mode is active
- For beta deployments, a cron-based periodic backup is sufficient

## Current Beta Scope

- Key-based registration and login
- Direct and group conversation creation
- E2E text messaging with X3DH + Double Ratchet bootstrap
- Offline encrypted message queue delivery
- Encrypted file upload/download
- Audio/video calling over mediasoup SFU
- Electron tray + local secure key storage

## Known Limitations

- Server does not persist a full message history yet; it stores an offline relay queue only
- Conversation metadata such as `lastMessage`, `lastMessageAt`, `unreadCount`, `muted`, and `pinned` is still client-driven rather than fully server-backed
- Pending auth challenges are in-memory only and assume a single server instance
- SQLite is suitable for beta single-node deployment, not for elastic scaling
- Electron sandboxing is enabled, but broader desktop hardening is still incomplete

## Troubleshooting

- `JWT_SECRET must not use the example value in production`: replace the template secret in your env file
- `CORS_ORIGIN must be set in production`: define the exact allowed desktop/web origins
- WebSocket works but calls fail: verify firewall UDP range and `SFU_ANNOUNCED_IP`
- File downloads return `410 FILE_MISSING`: restore the missing blob from upload backups or remove stale metadata
