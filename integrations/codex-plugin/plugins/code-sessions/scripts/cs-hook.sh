#!/usr/bin/env bash
# code-sessions Codex hook — forward the hook payload (stdin) to the code-sessions
# daemon. Silent + non-blocking: always exits 0, never blocks a Codex turn, and is a
# no-op when the daemon isn't running. Codex runs hooks with a restricted PATH, so we
# resolve the `code-sessions` binary from the usual global-install locations.
for c in code-sessions \
         "$HOME"/.nvm/versions/node/*/bin/code-sessions \
         /usr/local/bin/code-sessions /opt/homebrew/bin/code-sessions; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
    "$c" hook >/dev/null 2>&1
    exit 0
  fi
done
exit 0
