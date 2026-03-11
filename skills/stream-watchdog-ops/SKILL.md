---
name: stream-watchdog-ops
description: Use when working on the Stream Watchdog control plane in this repository or on a deployed instance. This skill covers local development, SQLite-backed control-plane changes, dashboard fixes, SSH-monitoring workflows, safe deployment, OpenClaw skill packaging, and production verification.
---

# Stream Watchdog Ops

Use this skill when the task is about operating or extending the Stream Watchdog control plane:

- patching backend or dashboard behavior
- adding or fixing monitoring, recovery, grouping, auth, CDK, or workspace features
- debugging a deployed instance
- preparing a release or remote deployment
- packaging or updating the companion OpenClaw skill

Do not use this skill for generic Node.js work unrelated to Stream Watchdog.

## Workflow

1. Build context from the codebase first.
   Read only the files relevant to the requested area. Common entry points:
   - `package.json`
   - `src/index.js`
   - `src/database.js`
   - `src/monitor.js`
   - `src/web.js`
   - `public/index.html`
   - `public/app.next.js`
   - `public/styles.css`
2. Protect secrets before doing anything else.
   - Never commit `.env`, `data/`, real SSH passwords, API keys, or `config/watcher.local.json`.
   - Treat remote server credentials and OAuth secrets as live secrets.
3. Make the smallest coherent change that solves the task.
   - Keep super-admin and customer-facing behavior clearly separated.
   - Preserve the `group -> server -> stream` mental model.
   - Keep changes compatible with SQLite and the existing web API.
4. Run the relevant verification.
   - Minimum: `npm run selftest`
   - When config logic changes: `npm run check-config`
   - When UI structure changes: run a quick browser sanity check if practical
5. If the task includes deployment, use the safe deploy flow from [references/operations.md](references/operations.md).

## Working Rules

- Use `apply_patch` for manual edits.
- Prefer fixing regressions with tests or selftest coverage when the path is clear.
- For monitoring logic, keep restart behavior conservative:
  - avoid infinite retry loops
  - preserve cooldown and restart-window protections
  - prefer explicit validation over implicit assumptions
- For multi-workspace changes, validate tenant/workspace boundaries explicitly.
- For dashboard work, surface faults first. Healthy items can stay collapsed.

## OpenClaw Packaging

When the task is to package or update the OpenClaw skill:

1. Update this skill folder:
   - `skills/stream-watchdog-ops/SKILL.md`
   - `skills/stream-watchdog-ops/references/operations.md`
   - `skills/stream-watchdog-ops/agents/openai.yaml`
2. Regenerate `agents/openai.yaml` with `generate_openai_yaml.py` instead of hand-writing it.
3. Validate the skill with `quick_validate.py`.
4. If installing on a remote OpenClaw host, copy the skill into the OpenClaw workspace skill directory and symlink it into the active skill directory.

## When to Read References

- Read [references/operations.md](references/operations.md) when you need exact project commands, deployment steps, health checks, or packaging steps for the OpenClaw host.
