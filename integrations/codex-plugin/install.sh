#!/usr/bin/env bash
# Install the code-sessions Codex plugin.
# `codex exec` resolves relative hook commands against the CWD (not the plugin), so we
# copy the plugin to a STABLE location and pin the hook command to the ABSOLUTE wrapper
# path. Re-run any time; safe + idempotent. Requires `code-sessions` on PATH + a running
# daemon (`code-sessions start`) for capture.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${CODE_SESSIONS_CODEX_DEST:-$HOME/.code-sessions/codex-plugin}"
rm -rf "$DEST"; mkdir -p "$DEST"; cp -R "$HERE/." "$DEST/"
WRAP="$DEST/plugins/code-sessions/scripts/cs-hook.sh"
chmod +x "$WRAP"
python3 - "$DEST/plugins/code-sessions/hooks.json" "$WRAP" <<'PY'
import json,sys
p,w=sys.argv[1],sys.argv[2]; d=json.load(open(p))
for ev in d["hooks"].values():
    for g in ev:
        for h in g["hooks"]: h["command"]=w
json.dump(d,open(p,"w"),indent=2)
PY
python3 - "$DEST/plugins/code-sessions/.codex-plugin/plugin.json" <<'PY'
import json,sys,time
p=sys.argv[1]; d=json.load(open(p)); d["version"]=d["version"].split("+")[0]+f"+cs.{int(time.time())}"
json.dump(d,open(p,"w"),indent=2)
PY
codex plugin marketplace add "$DEST" >/dev/null 2>&1 || true
codex plugin add code-sessions@code-sessions-dev
echo "code-sessions Codex plugin installed. Start the daemon: code-sessions start"
