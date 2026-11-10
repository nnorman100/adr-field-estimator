#!/usr/bin/env bash
# Decides whether the legacy app's checks need to run for this change.
#
# The old Python app (backend/, public/, tests/ and their tooling) is frozen reference code for
# the TypeScript rebuild in web/ and infra/dryscope/. Its other CI jobs were removed (see
# docs/RUNBOOK.md, "Legacy CI retired"); the CodeQL Python analysis is the one job that still calls
# this script right after checkout and skips its real steps, with a logged reason, when nothing the
# legacy app depends on changed.
#
# Inputs (environment): SUITE (name for the log), EVENT_NAME, BASE_SHA (base or before commit),
# GITHUB_OUTPUT. Output: run=true or run=false. When the base commit is unavailable (new branch,
# force push, scheduled run), the answer is always run=true.
#
# The first block of legacy_paths is the list the removed browser job in ci.yml used; the second
# block adds the unit-test and tooling files that the browser suite did not read.
set -euo pipefail

SUITE="${SUITE:-legacy checks}"
EVENT_NAME="${EVENT_NAME:-}"
BASE_SHA="${BASE_SHA:-}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

legacy_paths=(
  .github/workflows/ci.yml
  backend/
  public/
  index.html
  tests/browser/
  tests/browser_server.py
  tests/browser-auth.js
  tests/fakes.py
  tests/__init__.py
  ':(glob)playwright*.config.js'
  package.json
  package-lock.json
  firebase.json
  .firebaserc
  firestore.rules
  firestore.indexes.json
  scripts/artifact-paths.js
  scripts/ci_python_version.py
  scripts/manual_chrome.js
  scripts/verify_routing.js
  # Unit-test and tooling files below; the browser suite does not read these.
  .github/
  tests/
  ':(exclude)tests/fixtures/terraform/'
  scripts/
  ops/
  docs/ai-inventory.md
  docs/adr-pricing-source.md
  docs/pricing-source.md
  pyproject.toml
  eslint.config.js
  vitest.config.mjs
  .prettierrc.json
  .prettierignore
  ':(glob)**/*.py'
)

if [ -z "$BASE_SHA" ] || [[ "$BASE_SHA" =~ ^0+$ ]] || ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "Base commit ${BASE_SHA:-<empty>} is unavailable; running ${SUITE}."
  echo "run=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
if [ "$EVENT_NAME" = "push" ] && ! git merge-base --is-ancestor "$BASE_SHA" HEAD 2>/dev/null; then
  echo "Push base ${BASE_SHA} is not an ancestor of HEAD; running ${SUITE}."
  echo "run=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
if ! changed="$(git diff --no-renames --name-only "$BASE_SHA...HEAD" -- "${legacy_paths[@]}")"; then
  echo "Could not diff against ${BASE_SHA}; running ${SUITE}."
  echo "run=true" >> "$GITHUB_OUTPUT"
  exit 0
fi
if [ -z "$changed" ]; then
  echo "Skipping ${SUITE}: no legacy app, test or tooling files changed against ${BASE_SHA}."
  echo "run=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
echo "Running ${SUITE} because relevant files changed:"
echo "$changed"
echo "run=true" >> "$GITHUB_OUTPUT"
