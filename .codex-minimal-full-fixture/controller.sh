#!/bin/bash
set -euo pipefail
flock -n 9
case "${1:-}" in
 --plan) exec /usr/bin/python3 /tmp/codex-window-fixture-only/controller.py --plan ;;
 --execute) exec /usr/bin/python3 /tmp/codex-window-fixture-only/controller.py --execute ;;
 *) exit 1 ;;
esac
