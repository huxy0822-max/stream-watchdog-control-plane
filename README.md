# Stream Watchdog Control Plane

Stream Watchdog is a web control plane for operating large batches of YouTube live stream servers.
It monitors remote `ffmpeg` processes over SSH, detects broken or missing streams, and can automatically trigger recovery commands.

This repository is now structured as an English-first project with a browser dashboard, SQLite persistence, customer workspaces, CDK-based provisioning, and room to grow into managed service or hosted SaaS delivery later.

## Core capabilities

- Multi-server monitoring and automatic restart for `ffmpeg` live streams
- Issue-first dashboard with separate views for super admin and customer operators
- Separate auth routes for platform admin, customer ops, and CDK activation
- Public root only shows customer and CDK access; super admin is direct-route only
- Group-based hierarchy: `group -> server -> stream`
- Manual recovery, scheduled checks, cooldown and restart-window protection
- Managed stream creation from only a media filename/path and YouTube stream key
- One-click SSH discovery/import of currently running YouTube `ffmpeg` streams
- Customer workspaces, customer users, and CDK-based activation
- Batch CDK generation for repeatable service packages
- SQLite-backed state instead of local-only JSON scripts
- Built-in email notification settings
- Super-admin infrastructure panel showing host resources and application resource usage
- CRM-style sidebar navigation with dedicated pages per module
- Docker deployment support

## Product positioning

This codebase currently fits three deployment modes:

1. Managed service: you operate one control plane and issue CDKs to customers.
2. Dedicated deployment: you deploy one isolated instance for a customer.
3. Future hosted SaaS: the data model already has workspaces, users, sessions, quotas, and activation codes.

It is not yet a full billing-integrated SaaS platform. Direct payment, stronger billing automation, mobile clients, and YouTube API verification remain follow-up work.

## Security note

The repository does **not** ship with a baked-in default super-admin account.
On first boot, the system requires a bootstrap step in the web UI so credentials are created by the operator.

That is intentional. A public repository with a fixed `admin / 123456` credential would be unsafe by design.

## Quick start

1. Install dependencies:

```powershell
npm install
```

2. Prepare local environment:

```powershell
Copy-Item .env.example .env
Copy-Item config\watcher.example.json config\watcher.local.json
```

3. Fill the required values in `.env`:

```env
STREAM_WATCH_CONFIG=./config/watcher.local.json
STREAM_WATCH_WEB_HOST=127.0.0.1
STREAM_WATCH_WEB_PORT=3030
STREAM_WATCH_RACKNERD_ROOT_PASSWORD=your_real_ssh_password
```

4. Run validation:

```powershell
npm run selftest
npm run check-config
```

5. Start the dashboard:

```powershell
npm run start
```

6. Open:

```text
http://127.0.0.1:3030
```

On the first visit, create the super-admin account through the bootstrap page.

After bootstrap, the direct auth routes are:

- `/admin/login`
- `/customer/login`
- `/redeem`

The public root `/` intentionally does not expose the super-admin entry card.

## Repository layout

- `src/`: backend, monitoring engine, auth, database, web server
- `public/`: dashboard UI
- `config/watcher.example.json`: public-safe sample monitoring config
- `docs/`: user guide, admin guide, multilingual quick-start, deployment notes
- `deploy/`: service and reverse-proxy examples
- `skills/stream-watchdog-ops/`: companion OpenClaw skill for operating this control plane
- `compose.yml` + `Dockerfile`: container deployment

## Documentation

### English

- Customer guide: [docs/customer-guide.en.md](docs/customer-guide.en.md)
- Super-admin guide: [docs/admin-guide.en.md](docs/admin-guide.en.md)
- Deployment modes: [docs/deployment-modes.en.md](docs/deployment-modes.en.md)
- Multilingual quick-start: [docs/multilingual-quickstart.md](docs/multilingual-quickstart.md)

### Chinese

- 普通用户教程: [docs/customer-guide.md](docs/customer-guide.md)
- 超级管理员教程: [docs/admin-guide.md](docs/admin-guide.md)

## Docker deployment

```bash
docker compose up -d --build
```

By default the compose file binds the app to `127.0.0.1:3030`, so you can place Nginx or another reverse proxy in front of it.

## GitHub automation

This repository includes:

- `.github/workflows/nodejs-ci.yml`
- `.github/workflows/publish-github-packages.yml`
- `.github/workflows/datadog-synthetics.yml`

To enable Datadog Synthetics, configure:

- `DD_API_KEY` secret
- `DD_APP_KEY` secret
- `DD_SYNTHETICS_PUBLIC_IDS` repository variable
- optional `DATADOG_SITE` repository variable

The GitHub Packages workflow publishes `@huxy0822-max/stream-watchdog-control-plane` to GitHub Packages on manual trigger or release publish.

## What is intentionally not committed

- `.env`
- live runtime databases and keys under `data/`
- local real-world monitor config at `config/watcher.local.json`
- Playwright artifacts and local output folders

## Status

Implemented now:

- SSH monitoring and automatic restart logic
- workspace/user/CDK control plane
- batch CDK generation
- SSH live-stream discovery/import from remote servers
- group management and collapsible hierarchy explorer
- infrastructure metrics for super admin
- browser dashboard with customer/admin separation
- CRM-style sidebar navigation and dedicated module pages

Planned next:

- HTTPS automation
- richer alert channels
- payment and billing flows
- deeper SaaS controls
- optional YouTube API side verification
