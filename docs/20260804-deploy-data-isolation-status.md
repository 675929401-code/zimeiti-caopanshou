# 2026-08-04 Deploy and Data Isolation Status

## Current status

Git-to-server auto deployment is now fully closed.

Completed:

- Runtime releases are stored on the data disk under `/data/web/releases/`.
- `/www/agent-hub` points to `/data/web/current`.
- Protected runtime env is stored outside the release directory at `/data/agent-hub/env/.env.local`.
- Runtime uploads are stored outside the release directory at `/data/agent-hub/uploads`.
- COS is mounted at `/data/cos-bucket`.
- COS snapshot export is available and scheduled through `/data/agent-hub/deploy/run-cos-snapshot.sh`.
- Legacy business-data-to-Git backup cron is disabled.
- PM2 manages `agent-hub` and `agent-hub-gitee-webhook`.
- Nginx exposes `POST /deploy/gitee` on both HTTP and HTTPS; webhook authentication is handled by the protected server env file.
- Gitee deploy key added (ID: 5964843).
- Gitee webhook added (ID: 2110611), URL: `https://zyuani8.com/deploy/gitee`, event: Push.
- `git ls-remote git@gitee.com:zhujunguo/wangzhanbeifen.git main` succeeds.
- External HTTPS webhook test returned HTTP 200 and the server pulled the repository.

Status updated: 2026-08-04 01:40

## Intended flow

```text
Local Codex change
  -> push to Gitee origin/main
  -> Gitee WebHook POST /deploy/gitee
  -> server verifies webhook secret
  -> /data/agent-hub/deploy/git-auto-deploy.sh
  -> git fetch/reset main
  -> new /data/web/releases/release-time-commit
  -> install/build/health-check
  -> switch /data/web/current
  -> restart PM2 agent-hub
```

This is a server-pull deployment model, not Git directly writing to the server.

## Data boundaries

- Git stores source code, scripts, docs and deployment tooling.
- Supabase remains the primary store for structured business data: users, password hashes, agents, prompts, conversations, orders, credits, memberships and model/platform configs.
- `/data/agent-hub/uploads` stores runtime uploaded/generated assets locally.
- COS stores snapshots, object backups and disaster-recovery artifacts.
- Code deployment must not overwrite `.env.local`, uploads, database content or business snapshots.

## Operational rule

Do not report “Git auto deployment is fully active” until the server can successfully run:

```bash
git ls-remote git@gitee.com:zhujunguo/wangzhanbeifen.git main
```

No cloud secrets, webhook secrets, account passwords or private keys should be committed to Git.
