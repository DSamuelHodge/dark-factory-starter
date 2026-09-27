#!/usr/bin/env bash
# skills.sh — generates the full 150-agent Flue org from roles.json.
#
# Usage:
#   ./skills.sh              generate all agents/ + skills/ + registry.ts + wrangler.toml
#   ./skills.sh clean        remove generated agents/ skills/ registry.ts wrangler.toml
#   ./skills.sh count        print how many roles/areas are in roles.json
#
# This is the single entrypoint a dev (or a CI job, or an agent) runs to
# regenerate the whole 150-role AI digital twin whenever roles.json or
# area-config.json changes — it does not hand-maintain 150 files.

set -euo pipefail
cd "$(dirname "$0")"

case "${1:-generate}" in
  generate)
    echo "== Generating 150 Flue agents on the Cloudflare Agent Cloud stack =="
    node scripts/generate-agents.mjs
    ;;
  clean)
    echo "== Removing generated agents/skills/registry/wrangler config =="
    rm -rf agents skills registry.ts wrangler.toml
    ;;
  count)
    node -e "const r = require('./roles.json'); \
      console.log(r.length + ' roles across ' + new Set(r.map(x => x.area)).size + ' functional areas');"
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "Usage: ./skills.sh [generate|clean|count]" >&2
    exit 1
    ;;
esac
