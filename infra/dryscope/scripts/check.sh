#!/usr/bin/env bash
# Offline checks for infra/dryscope: format, validate, and the mocked test suites.
#
# Uses mock providers and `init -backend=false`, so it needs no Google Cloud
# credentials and cannot reach the real project. Set TERRAFORM to use a binary
# that is not on PATH. Terraform 1.9 or later is required.
set -euo pipefail

TF="${TERRAFORM:-terraform}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$TF" version | head -1
"$TF" fmt -check -recursive "$HERE"

for root in data app; do
  dir="$HERE/$root"
  echo "== $root: init, validate"
  "$TF" -chdir="$dir" init -backend=false -input=false -lockfile=readonly >/dev/null
  "$TF" -chdir="$dir" validate
  for env in test live; do
    echo "== $root: mocked tests ($env)"
    "$TF" -chdir="$dir" test -var-file="envs/$env.tfvars"
  done
done

echo "infra/dryscope checks passed"
