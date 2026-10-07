#!/usr/bin/env bash
# Runs ON the server (invoked by .github/workflows/deploy-tencent.yml over SSH).
# Never builds, never runs DB migrations, never touches shared/ or env files.
set -Eeuo pipefail
RELEASE_ID="$1"; TARBALL="$2"; COMMIT="$3"
ROOT=/data/web; RELEASES=$ROOT/releases; LINK=$ROOT/current-web
NODE=/data/direct-deploy/toolchain/bin/node   # v24.19.0, same as pm2 agent-hub-web interpreter
CAND_PORT=${CANDIDATE_PORT:-5090}; KEEP=${KEEP_RELEASES:-3}
DIR=$RELEASES/$RELEASE_ID
exec 9>$ROOT/.gh-deploy.lock; flock -n 9 || { echo "another deploy is running"; exit 1; }

echo "== disk"; df -h /data | tail -1
avail=$(df --output=avail -k /data | tail -1); [ "$avail" -gt 5000000 ] || { echo "less than 5GB free, abort"; exit 1; }
[ ! -e "$DIR" ] || { echo "$DIR already exists"; exit 1; }

echo "== extract"; mkdir -p "$DIR/web"; tar -xzf "$TARBALL" -C "$DIR/web"; rm -f "$TARBALL"
find "$DIR/web" -name '.env*' ! -name '*.example' -prune -exec rm -rf {} +

BUILD_ID=$(cat "$DIR/web/.next/BUILD_ID")
echo "== candidate health check on :$CAND_PORT (build $BUILD_ID)"
WEB_PID=$(pm2 pid agent-hub-web | tail -1)
[ -n "$WEB_PID" ] && [ "$WEB_PID" != 0 ] || { echo "agent-hub-web not running"; exit 1; }
# reuse the exact runtime env of the live web process (secrets stay on the server)
mapfile -d '' ENVV < /proc/$WEB_PID/environ
( cd "$DIR/web" && env -i "${ENVV[@]}" PORT=$CAND_PORT RELEASE_ID=$RELEASE_ID DEPLOY_COMMIT_SHA=$COMMIT EXPECTED_BUILD_ID=$BUILD_ID \
    MEDIA_QUEUE_WORKER_PROCESS=0 DIGITAL_VIDEO_QUEUE_WORKER=0 DIGITAL_HUMAN_LONG_WORKER=0 \
    "$NODE" server.js > /tmp/gh-candidate-$RELEASE_ID.log 2>&1 ) &
CPID=$!
ok=0; for i in $(seq 1 60); do
  sleep 2
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:$CAND_PORT/api/version)" = 200 ] \
     && [ "$(curl -s -o /dev/null -w '%{http_code}' -m 20 http://127.0.0.1:$CAND_PORT/)" = 200 ]; then ok=1; break; fi
done
kill $CPID 2>/dev/null || true; pkill -f "$DIR/web/server.js" 2>/dev/null || true; pkill -P $CPID 2>/dev/null || true
if [ $ok != 1 ]; then echo "candidate failed"; tail -40 /tmp/gh-candidate-$RELEASE_ID.log; chmod -R u+w "$DIR"; rm -rf "$DIR"; exit 1; fi
echo "candidate OK"
[ "${SWITCH:-0}" = 1 ] || { echo "SWITCH!=1: candidate verified, NOT switching (release kept at $DIR)"; exit 0; }

echo "== atomic switch"
PREV=$(readlink -f "$LINK")
ln -sfn "$DIR/web" "$ROOT/.current-web.tmp" && mv -Tf "$ROOT/.current-web.tmp" "$LINK"
RELEASE_ID=$RELEASE_ID DEPLOY_COMMIT_SHA=$COMMIT EXPECTED_BUILD_ID=$BUILD_ID pm2 reload agent-hub-web --update-env
healthy=0; for i in $(seq 1 45); do sleep 2
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:5000/api/version)" = 200 ] && { healthy=1; break; }; done
if [ $healthy != 1 ]; then
  echo "post-switch health failed, rolling back to $PREV"
  ln -sfn "$PREV" "$ROOT/.current-web.tmp" && mv -Tf "$ROOT/.current-web.tmp" "$LINK"
  pm2 reload agent-hub-web --update-env; exit 1
fi
pm2 save >/dev/null 2>&1 || true
echo "live: $(curl -s -m 5 http://127.0.0.1:5000/api/version | head -c 300)"

echo "== prune (only gh-* releases, keep $KEEP newest, never referenced ones)"
REFS=$( { readlink -f "$LINK"; pm2 jlist; nginx -T 2>/dev/null; } )
ls -1dt $RELEASES/gh-* 2>/dev/null | tail -n +$((KEEP+1)) | while read d; do
  echo "$REFS" | grep -qF "$d" && { echo "keep referenced $d"; continue; }
  chmod -R u+w "$d"; rm -rf "$d"; echo "pruned $d"; done
df -h /data | tail -1
