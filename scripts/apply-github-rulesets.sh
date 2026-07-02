#!/usr/bin/env bash
# Apply repository rulesets from .github/rulesets/*.json via GitHub CLI.
# Usage: ./scripts/apply-github-rulesets.sh [owner/repo]
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
RULESET_DIR="$(cd "$(dirname "$0")/../.github/rulesets" && pwd)"

echo "Repository: $REPO"

list_rulesets() {
  gh api "repos/$REPO/rulesets" --jq '.[] | "\(.id)\t\(.name)\t\(.enforcement)"'
}

upsert_ruleset() {
  local file="$1"
  local name
  name="$(jq -r '.name' "$file")"

  local existing_id
  existing_id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1 || true)"

  if [[ -n "$existing_id" ]]; then
    echo "Updating ruleset \"$name\" (id=$existing_id) from $(basename "$file")"
    gh api -X PUT "repos/$REPO/rulesets/$existing_id" --input "$file" >/dev/null
  else
    echo "Creating ruleset \"$name\" from $(basename "$file")"
    gh api -X POST "repos/$REPO/rulesets" --input "$file" >/dev/null
  fi
}

echo "Current rulesets:"
list_rulesets || true
echo

for file in "$RULESET_DIR"/*.json; do
  [[ -f "$file" ]] || continue
  upsert_ruleset "$file"
done

echo
echo "Rulesets after apply:"
list_rulesets
