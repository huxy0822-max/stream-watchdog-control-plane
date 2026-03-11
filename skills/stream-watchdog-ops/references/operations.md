# Stream Watchdog Operations Reference

## Project entry points

- Backend bootstrap: `src/index.js`
- Web API and auth: `src/web.js`
- Persistence and tenancy rules: `src/database.js`
- Monitoring and SSH recovery: `src/monitor.js`
- Runtime metrics: `src/runtime-metrics.js`
- Main dashboard UI: `public/app.next.js`
- Static shell: `public/index.html`
- Styles: `public/styles.css`

## Local commands

```powershell
npm install
npm run selftest
npm run check-config
npm run start
```

## Public-safe config files

- `.env.example`
- `config/watcher.example.json`

Real secrets belong in:

- `.env`
- `config/watcher.local.json`

Never commit either of those files.

## Docker deployment flow

1. Review the live config and the code change.
2. Rebuild locally if possible:

```powershell
docker compose build
```

3. On the Linux host:

```bash
cd /opt/stream-watchdog
docker compose up -d --build
docker compose ps
docker compose logs --tail=200
```

## Health checks

- Setup status: `/api/setup/status`
- Authenticated dashboard state: `/api/admin/state`
- First-boot flow should require bootstrap when the database is empty.
- Super-admin responses should include `runtimeMetrics`.
- Customer responses must not include super-admin-only data such as `runtimeMetrics`, tenant lists, or redeem codes.

## High-risk areas

- `src/database.js`
  - workspace boundary checks
  - quota enforcement
  - server-to-stream tenant consistency
  - group migration behavior
- `src/monitor.js`
  - matching `ffmpeg` processes correctly
  - restart throttling
  - SSH error handling
- `src/web.js`
  - auth/session handling
  - super-admin-only route protection
- `public/app.next.js`
  - super-admin vs customer UI split
  - collapse/expand matrix behavior
  - forms that depend on workspace or group selection

## OpenClaw skill update flow

Generate OpenAI metadata:

```powershell
py C:\Users\Hu\.codex\skills\.system\skill-creator\scripts\generate_openai_yaml.py `
  C:\Users\Hu\Documents\Playground\skills\stream-watchdog-ops `
  --interface display_name=\"Stream Watchdog Ops\" `
  --interface short_description=\"Operate Stream Watchdog control planes\" `
  --interface default_prompt=\"Use $stream-watchdog-ops to inspect, patch, validate, and deploy the Stream Watchdog control plane.\"
```

Validate the skill:

```powershell
py C:\Users\Hu\.codex\skills\.system\skill-creator\scripts\quick_validate.py `
  C:\Users\Hu\Documents\Playground\skills\stream-watchdog-ops
```

Install on an OpenClaw Linux host:

```bash
mkdir -p /root/.openclaw/workspace/skills/stream-watchdog-ops
ln -sfn /root/.openclaw/workspace/skills/stream-watchdog-ops /root/.openclaw/skills/stream-watchdog-ops
```

Copy these paths into the remote skill folder:

- `SKILL.md`
- `agents/openai.yaml`
- `references/operations.md`

## Release checklist

1. `npm run selftest`
2. `npm run check-config`
3. Confirm `.env`, runtime DBs, and real monitor configs are not staged.
4. Rebuild the remote container if the deployed host is part of the task.
5. Verify login, dashboard state, and at least one super-admin-only panel after deploy.
