#!/usr/bin/env bash
# Offline checks for infra/dryscope: format, validate, the mocked test suites, and the
# closed-set plan check over every mocked plan (scripts/check-plan.js, needs node).
#
# Uses mock providers and `init -backend=false`, so it needs no Google Cloud
# credentials and cannot reach the real project. Set TERRAFORM to use a binary
# that is not on PATH. Terraform 1.9 or later is required.
set -euo pipefail

TF="${TERRAFORM:-terraform}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$TF" version | head -1
"$TF" fmt -check -recursive "$HERE"

for root in data app; do
  dir="$HERE/$root"
  echo "== $root: init, validate"
  "$TF" -chdir="$dir" init -backend=false -input=false -lockfile=readonly >/dev/null
  "$TF" -chdir="$dir" validate
  for env in test live; do
    echo "== $root: mocked tests ($env)"
    extra=()
    if [ "$root" = app ]; then extra=(-var-file="tests/images-$env.tfvars"); fi
    "$TF" -chdir="$dir" test -var-file="envs/$env.tfvars" "${extra[@]}"
    echo "== $root: plan check ($env)"
    "$TF" -chdir="$dir" test -json -verbose -var-file="envs/$env.tfvars" "${extra[@]}" |
      node "$HERE/scripts/check-plan.js" "$root" "$env" -
  done
  # Terraform must refuse to destroy every protected resource. The teardown of the
  # mocked apply is expected to fail, so its exit status is ignored; the report is checked.
  echo "== $root: destroy guards"
  extra=()
  if [ "$root" = app ]; then extra=(-var-file="tests/images-test.tfvars"); fi
  "$TF" -chdir="$dir" test -test-directory=guards -json -var-file="envs/test.tfvars" "${extra[@]}" >"$TMP/$root-guards.json" || true
  node "$HERE/scripts/check-guards.js" "$root" "$TMP/$root-guards.json"
done

echo "infra/dryscope checks passed"
