#!/usr/bin/env bash
set -euo pipefail
WINDOW_SESSION_STARTED=0
WINDOW_SESSION_STATE=closed
WINDOW_SESSION_SEQ=0
window_session_authorize_parent() { return 0; }
window_session_open() {
  [[ "$WINDOW_SESSION_STATE" == closed ]] || return 1
  WINDOW_SESSION_STARTED=1
  WINDOW_SESSION_STATE=unknown
  window_session_authorize_parent || return 79
  [[ ( -p /proc/self/fd/3 || -S /proc/self/fd/3 ) && ( -p /proc/self/fd/4 || -S /proc/self/fd/4 ) ]] || return 1
  WINDOW_SESSION_READ_FD=3
  WINDOW_SESSION_WRITE_FD=4
  local response
  if ! IFS= read -r -t 10 response <&3 || [[ "$response" != '{"type":"ready"}' ]]; then return 1; fi
  WINDOW_SESSION_STATE=active
}
window_session_request() {
  local phase="$1" response next response_type=ok
  [[ "$WINDOW_SESSION_STATE" == active ]] || return 1
  next=$((WINDOW_SESSION_SEQ+1))
  case "$next:$phase" in
    1:preflight-ok) response_type=resume ;;
    2:prepare|3:activated|4:precommit|5:persisted) ;;
    *) WINDOW_SESSION_STATE=unknown; return 1 ;;
  esac
  if ! printf '{"phase":"%s","seq":%s}\n' "$phase" "$next" >&4; then WINDOW_SESSION_STATE=unknown; return 1; fi
  if ! IFS= read -r -t 10 response <&3; then WINDOW_SESSION_STATE=unknown; return 1; fi
  if [[ "$response" != "{\"type\":\"$response_type\",\"seq\":$next,\"phase\":\"$phase\"}" ]]; then WINDOW_SESSION_STATE=unknown; return 1; fi
  WINDOW_SESSION_SEQ=$next
}
window_session_rollback_authorized() { return 79; }
window_session_close() {
  [[ "$WINDOW_SESSION_STATE" == active && "$WINDOW_SESSION_SEQ" == 5 ]] || return 1
  # EOF is not permission to restore ingress; parent must also authenticate the
  # controller exit and its durable SUCCESS record. Keep rollback suppressed
  # until the controller has committed its own SUCCESS below.
  exec 4>&- || return 1
  exec 3<&- || return 1
  WINDOW_SESSION_STATE=closed
}
window_session_open
window_session_request preflight-ok
window_session_request prepare
window_session_request activated
window_session_request precommit
window_session_request persisted
window_session_close
