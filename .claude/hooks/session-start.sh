#!/bin/bash
# Instala el CLI de sports-skills (lo usan las skills en .claude/skills).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && command -v sports-skills >/dev/null 2>&1; then
  exit 0
fi

if ! command -v sports-skills >/dev/null 2>&1; then
  python3 -m pip install --quiet --disable-pip-version-check sports-skills 2>/dev/null \
    || python3 -m pip install --quiet --disable-pip-version-check --break-system-packages sports-skills
fi
