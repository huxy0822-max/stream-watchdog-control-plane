# Release workflow

## Goal

Keep production stable, run new changes locally first, and preserve the last three production versions for fast rollback.

## Local test profile

Use the test profile for all unfinished work:

```powershell
npm run start:test
```

Default test profile behavior:

- Web UI: `http://127.0.0.1:3031`
- Cookie name: `stream_watch_session_test`
- Database: `./data/stream-watchdog.test.db`
- Master key: `./data/master.test.key`
- State file: `./data/state.test.json`
- Legacy import config: `./config/watcher.example.json`

Optional local overrides:

1. Copy `.env.test.example` to `.env.test.local`
2. Adjust values if you want a different test port or file layout

## Production deploy

1. Copy `.env.production.example` to `.env.production.local`
2. Fill the SSH target for the production management server
3. Deploy:

```powershell
npm run deploy:prod
```

The deploy script will:

- upload the current repository snapshot to a temporary remote directory
- back up the current production app into `/opt/stream-watchdog-releases/<timestamp>-<gitsha>`
- deploy the new code to `/opt/stream-watchdog`
- rebuild the Docker service
- keep only the latest 3 production backups

## List available rollback versions

```powershell
npm run releases:prod
```

## Roll back production

Roll back to the latest retained backup:

```powershell
npm run rollback:prod
```

Roll back to a specific backup:

```powershell
npm run rollback:prod -- --release 20260311-203000-abcdef1
```

## Suggested git workflow

- Keep `master` as the deployed production branch
- Create and use a local development branch such as `codex/local-test`
- Only deploy after local validation passes on the test profile
