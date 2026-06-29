#!/usr/bin/env bash
# Realistic capture harness: run the actual claude / codex / grok CLIs on short
# coding tasks across a couple of git projects and a couple of identities/hosts,
# with an OTLP sink catching each agent's real telemetry. Captures both the native
# OTel emissions AND the resulting transcripts into a capture dir.
#
#   bash test/harness/run-capture.sh [CAPTURE_DIR]
#
# Each agent run sets a distinct git identity + CODE_SESSIONS_HOST so the captured
# sessions exercise enrichment-by-project / -user / -host. Requires the CLIs to be
# installed + authed; runs are tiny + time-boxed. Re-runnable.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CAP="${1:-$HERE/../.capture}"
WORK="$(mktemp -d)"
SINK_PORT="${SINK_PORT:-4318}"
mkdir -p "$CAP"
echo "capture → $CAP   work → $WORK"

# --- two realistic git projects (shallow OSS clones, else local fallback) -------
mkproj() { # name origin-url
  local d="$WORK/$1"
  if git clone --depth 1 "$2" "$d" >/dev/null 2>&1; then echo "$d"; return; fi
  mkdir -p "$d"; ( cd "$d" && git init -q && git remote add origin "$2" \
    && printf 'export const add = (a, b) => a + b\n' > index.js \
    && printf '# %s\n' "$1" > README.md && git add -A && git -c user.email=seed@x -c user.name=seed commit -qm init )
  echo "$d"
}
PROJ_A="$(mkproj app-web https://github.com/sindresorhus/slugify.git)"
PROJ_B="$(mkproj app-api https://github.com/sindresorhus/is-odd.git)"

# --- identities × hosts ---------------------------------------------------------
setid() { git -C "$1" config user.email "$2"; git -C "$1" config user.name "$3"; }
setid "$PROJ_A" alice@example.com "Alice"
setid "$PROJ_B" bob@example.com   "Bob"

# --- OTLP sink ------------------------------------------------------------------
SINK_OUT="$CAP/otel" SINK_PORT="$SINK_PORT" node "$HERE/otlp-sink.mjs" &
SINK_PID=$!; sleep 1
trap 'kill $SINK_PID 2>/dev/null; rm -rf "$WORK"' EXIT

otel_env=( CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:$SINK_PORT"
  OTEL_METRIC_EXPORT_INTERVAL=2000 OTEL_LOGS_EXPORT_INTERVAL=2000 )

# `timeout` is GNU-only; fall back to `gtimeout` (brew coreutils) or no bound on macOS.
TO="$(command -v timeout || command -v gtimeout || true)"
run() { # agent host dir cmd...
  local agent="$1" host="$2" dir="$3"; shift 3
  echo "── $agent @ $host in $(basename "$dir") ──"
  ( cd "$dir" && env "${otel_env[@]}" CODE_SESSIONS_HOST="$host" ${TO:+"$TO" 180} "$@" ) \
    > "$CAP/$agent.$host.out.txt" 2>&1 || echo "  ($agent exited non-zero/timeout — captured what we got)"
}

TASK='Add a one-line JSDoc comment above the first function in index.js, then stop. Keep it to one tool call.'

# Claude Code (push hooks + OTel), Codex (exec + OTel), Grok (transcript only).
run claude alice-mbp "$PROJ_A" claude -p "$TASK" --output-format json --permission-mode acceptEdits
run codex  bob-mini  "$PROJ_B" codex exec --skip-git-repo-check "$TASK"
run grok   alice-mbp "$PROJ_A" grok -p "$TASK" --output-format json

# --- collect transcripts produced during the runs ------------------------------
mkdir -p "$CAP/transcripts/claude" "$CAP/transcripts/codex" "$CAP/transcripts/grok"
find "$HOME/.claude/projects" -name '*.jsonl' -newermt '-4 minutes' -exec cp {} "$CAP/transcripts/claude/" \; 2>/dev/null
find "$HOME/.codex/sessions"  -name '*.jsonl' -newermt '-4 minutes' -exec cp {} "$CAP/transcripts/codex/"  \; 2>/dev/null
find "$HOME/.grok/sessions"   -name 'chat_history.jsonl' -newermt '-4 minutes' -exec cp {} "$CAP/transcripts/grok/" \; 2>/dev/null

echo "── captured ──"
echo "otel signals: $(ls "$CAP/otel" 2>/dev/null | tr '\n' ' ')"
echo "transcripts:  claude=$(ls "$CAP/transcripts/claude" 2>/dev/null | wc -l | tr -d ' ') codex=$(ls "$CAP/transcripts/codex" 2>/dev/null | wc -l | tr -d ' ') grok=$(ls "$CAP/transcripts/grok" 2>/dev/null | wc -l | tr -d ' ')"
echo "Note: redact with make-fixtures.mts before committing anything from $CAP."
