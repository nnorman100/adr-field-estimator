#!/usr/bin/env bash
# Installs crane (github.com/google/go-containerregistry), pinned by version and checksum, into the
# directory given. crane assembles and pushes images without a Docker daemon (web/scripts/build-image.sh).
# A download whose checksum does not match is never unpacked or run.
#
#   web/scripts/install-crane.sh <directory>
set -euo pipefail

VERSION=v0.22.1
case "$(uname -s)_$(uname -m)" in
  Linux_x86_64) ASSET=go-containerregistry_Linux_x86_64.tar.gz
    SHA256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 ;;
  Darwin_arm64) ASSET=go-containerregistry_Darwin_arm64.tar.gz
    SHA256=2231fc8df8806d20d680ff1225db44e095a55dd6ac1ae8eced4faf4b278b78fb ;;
  Darwin_x86_64) ASSET=go-containerregistry_Darwin_x86_64.tar.gz
    SHA256=6fedd06a648c11335f0e8b9547e4783002c30e9336047fec292942cd518bb799 ;;
  *) echo "install-crane: no pinned crane for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

dir=${1:?usage: install-crane.sh <directory>}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$ASSET" "https://github.com/google/go-containerregistry/releases/download/$VERSION/$ASSET"
if command -v sha256sum >/dev/null; then
  echo "$SHA256  $tmp/$ASSET" | sha256sum --check --strict
else
  echo "$SHA256  $tmp/$ASSET" | shasum -a 256 --check --strict
fi
mkdir -p "$dir"
tar -xzf "$tmp/$ASSET" -C "$dir" crane
echo "crane $VERSION installed in $dir"
