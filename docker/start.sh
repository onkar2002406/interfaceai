#!/usr/bin/env bash
# Container entrypoint. One argument selects what this container runs:
#
#   corebank   the three CoreBank tenant instances (ports 4000-4002),
#              the CoreBank control panel (PANEL_PORT, default 4200) and
#              its in-process operator console (OPERATOR_PORT, default 4100)
#
#   meridian   the control panel pointed at the hosted MERIDIAN CORE target
#              (PANEL_PORT, default 4300) and its operator console
#              (OPERATOR_PORT, default 4101). No local target is started —
#              MERIDIAN is remote.
#
# The React bundle is already built into the image, so this calls the CLI
# through tsx directly instead of `npm run panel`, which would rebuild it on
# every start.
set -euo pipefail

MODE="${1:-corebank}"
CLI="node_modules/.bin/tsx src/cli/index.ts"

pids=()
cleanup() { for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

case "$MODE" in
  corebank)
    echo "==> starting CoreBank tenant instances (4000, 4001, 4002)"
    $CLI app &
    pids+=($!)

    # Wait for the reference install before bringing the panel up, so the
    # panel's first health check sees a live target.
    for _ in $(seq 1 30); do
      if curl -sf "http://localhost:4000/login" >/dev/null 2>&1; then break; fi
      sleep 1
    done

    echo "==> starting CoreBank control panel (${PANEL_PORT:-4200}) + operator console (${OPERATOR_PORT:-4100})"
    TARGET_ALREADY_STARTED=1 $CLI panel --port "${PANEL_PORT:-4200}" --operator-port "${OPERATOR_PORT:-4100}" &
    pids+=($!)
    ;;

  meridian)
    echo "==> starting MERIDIAN control panel (${PANEL_PORT:-4300}) + operator console (${OPERATOR_PORT:-4101})"
    echo "    target: hosted at https://web-sample.interface-hiring.com (nothing local to start)"
    $CLI panel --profile config/apps/meridian-core.yaml \
      --port "${PANEL_PORT:-4300}" --operator-port "${OPERATOR_PORT:-4101}" &
    pids+=($!)
    ;;

  *)
    echo "unknown mode '$MODE' — expected 'corebank' or 'meridian'" >&2
    exit 2
    ;;
esac

# Exit as soon as any supervised process exits, propagating its status.
status=0
wait -n || status=$?
echo "==> a supervised process exited (status $status); shutting the container down"
exit "$status"
