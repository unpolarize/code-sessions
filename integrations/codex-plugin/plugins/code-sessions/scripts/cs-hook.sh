#!/usr/bin/env bash
# code-sessions Codex hook — forward the hook payload (stdin) to the daemon.
# Silent + non-blocking; codex hooks get a restricted PATH so resolve robustly.
for c in code-sessions "$HOME"/.nvm/versions/node/*/bin/code-sessions /usr/local/bin/code-sessions /opt/homebrew/bin/code-sessions; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then "$c" hook >/dev/null 2>&1; exit 0; fi
done
exit 0
