# Agent Hub Full Git Release Standard

This project now has one supported production release path:

```text
local workspace
  -> scripts/publish-gitee-full.mjs
  -> Gitee main branch, fixed source subdir
  -> Gitee webhook
  -> scripts/git-auto-deploy.sh on the server
  -> immutable release directory
  -> health checks and runtime contract
  -> current symlink switch
```

## Source Of Truth

- Code source: this workspace, published into the Gitee source directory.
- Gitee repository: `git@gitee.com:zhujunguo/wangzhanbeifen.git`
- Branch: `main`
- Release source subdir: `自媒体操盘手/V2.6_20260806_沙箱项目定稿/源码`
- Server release script: `scripts/git-auto-deploy.sh`
- Webhook receiver: `scripts/gitee-webhook-server.mjs`

Runtime data is not code and must not be published through Git:

- `.env.local` and any secret files
- `node_modules`, `.next`, caches and build outputs
- `public/uploads`, `public/avatars`
- `backups`, database snapshots, COS files and user-generated media

## Local Publish

Use this from the project root:

```bash
pnpm run release:preflight
pnpm run release:publish -- --dry-run
pnpm run release:publish -- "release: describe this change"
```

`release:publish` runs the cross-platform Node publisher and does the following:

1. Runs `scripts/release-preflight.mjs`.
2. Clones the Gitee repo into `/tmp`.
3. Replaces the configured source subdir with the complete current source tree.
4. Excludes runtime data, secrets, dependencies and build output.
5. Writes `deploy-manifest.json`.
6. Runs preflight again against the packaged source.
7. Commits and pushes to `main`.

If there is no diff, it exits without a push.

## Server Deploy

The server must deploy only from Git:

```bash
pnpm run release:deploy
```

The server script:

1. Verifies `/data` is mounted when `REQUIRE_DATA_MOUNT=1`.
2. Requires the protected env file at `$DATA_ROOT/env/.env.local`.
3. Uses a deployment lock.
4. Fetches `origin/main`.
5. Refuses non-full deployment mode.
6. Archives the configured Git source subdir into a new release directory.
7. Verifies required files are present.
8. Runs packaged preflight.
9. Symlinks protected `.env.local` and runtime uploads.
10. Installs dependencies and builds.
11. Switches `/data/web/current` only after build succeeds.
12. Starts PM2.
13. Checks public routes and `verify:runtime`.
14. Rolls back to the previous release if health checks fail.

## Required Release Checks

Every production release must satisfy all of these:

```bash
pnpm run release:preflight
pnpm run ts-check
pnpm exec next build --webpack
VERIFY_PUBLIC_ONLY=1 BASE_URL=http://127.0.0.1:5000 pnpm run verify:runtime
```

The deployed version is valid only when these three values match:

- Gitee `main` commit hash.
- `/api/version` hash returned by the live service.
- Current server release directory name or manifest.

## Disabled Legacy Entries

The old overwrite-style deploy scripts are intentionally disabled:

- `scripts/deploy.sh`
- `scripts/deploy-prod.sh`
- `scripts/deploy-full.js`
- `scripts/deploy-direct.js`
- `scripts/deploy-ssh.js`
- `scripts/deploy-tencent.sh`
- `scripts/deploy-to-tencent.sh`
- `scripts/sync-deploy.sh`
- `scripts/sync-to-server.sh`
- `scripts/git-backup.sh`

They must not be re-enabled for production. If a new deployment method is needed, it must preserve the same invariants: Git source, immutable release, protected env, no runtime data overwrite, health checks, and rollback.

## Hardening Requirements

- Rotate any SSH key that was ever stored in a repository or script.
- Use a server-side deploy key with read-only Git access for deployment.
- Keep webhook secrets in protected server environment variables.
- Keep production `.env.local` only under `$DATA_ROOT/env/.env.local`.
- Treat failed preflight, failed build, failed health check or failed runtime contract as a failed deployment.
- Never publish database snapshots or service-role keys through Git.
