#!/usr/bin/env bash
# Builds a production image for the rebuilt app WITHOUT a Docker daemon (owner decision 2026-11-10,
# made for the former self-hosted CI pool; kept so the build does not depend on the runner image). The app goes into one layer under /app, owned by root and
# read-only to the image's unprivileged node user, appended with crane onto the base image pinned
# in web/Dockerfile. The image holds no environment-specific values and no secrets: Cloud Run
# supplies APP_ENV and the rest, and the app refuses to start without them.
#
#   web/scripts/build-image.sh web --commit <40-character commit> --version <YYYY.MM.DD-N> (--tag <ref> | --output <file>) [--stage <dir>]
#   web/scripts/build-image.sh live-placeholder (--tag <ref> | --output <file>) [--stage <dir>]
#
# web builds the Next.js standalone output with npm (run `npm ci` in web/ first) and bakes in the
# commit and the release version (docs/plans/TC.md, TC-8), which /api/health reports. It also carries the migration job: /app/migrate.mjs (bundled by
# scripts/build-migrate.mjs) and the numbered ledger in /app/migrations, which the Cloud Run job
# starts with `node migrate.mjs` (infra/dryscope/app/migrate_job.tf), so every release migrates
# with the same image, by digest, that it then deploys. live-placeholder is the 503 stand-in in
# live-relay-placeholder/ that the app root needs until stage S7. --tag pushes to a registry; --output writes an image
# tarball instead. --stage keeps the assembled /app tree there (the Web app check runs it with node).
# Needs crane (web/scripts/install-crane.sh), GNU tar (set TAR=gtar on macOS) and, for web, npm.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CRANE=${CRANE:-crane}
TAR=${TAR:-tar}

fail() { echo "build-image: $*" >&2; exit 1; }

app=${1:-}
[ "$app" = web ] || [ "$app" = live-placeholder ] || fail 'first argument must be web or live-placeholder'
shift
commit='' version='' tag='' output='' stage=''
while [ $# -gt 0 ]; do
  case $1 in
    --commit) commit=${2:-}; shift 2 ;;
    --version) version=${2:-}; shift 2 ;;
    --tag) tag=${2:-}; shift 2 ;;
    --output) output=${2:-}; shift 2 ;;
    --stage) stage=${2:-}; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done
if [ -n "$tag" ] && [ -n "$output" ]; then fail 'give --tag or --output, not both'; fi
[ -n "$tag$output" ] || fail 'give --tag <ref> or --output <file>'
if [ "$app" = web ]; then
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'web needs --commit <40-character commit>'
  [[ $version =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]{0,5}$ ]] || fail 'web needs --version <YYYY.MM.DD-N>'
elif [ -n "$version" ]; then
  fail 'only the web image carries a release version'
fi
"$TAR" --version 2>/dev/null | grep -q 'GNU tar' || fail 'needs GNU tar (on macOS: brew install gnu-tar, then TAR=gtar)'

base=$(sed -n 's/^FROM //p' "$root/web/Dockerfile")
[[ $base =~ ^node:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || fail "web/Dockerfile must pin one digest-pinned node base, found: $base"

stage=${stage:-$(mktemp -d)}
rm -rf "$stage/app" "$stage/layer.tar"
mkdir -p "$stage/app"
env=(--env NODE_ENV=production --env PORT=8080)
if [ "$app" = web ]; then
  [ -d "$root/web/node_modules" ] || fail 'run npm ci in web/ first'
  (cd "$root/web" && NEXT_TELEMETRY_DISABLED=1 npm run build)
  cp -a "$root/web/.next/standalone/." "$stage/app/"
  mkdir -p "$stage/app/.next"
  cp -a "$root/web/.next/static" "$stage/app/.next/static"
  # The standalone output leaves public/ out: the icons and the field worker (/sw.js) are served from it.
  cp -a "$root/web/public" "$stage/app/public"
  (cd "$root/web" && npm run --silent build:migrate -- "$stage/app")
  env+=(--env HOSTNAME=0.0.0.0 --env NEXT_TELEMETRY_DISABLED=1 --env "APP_COMMIT=$commit" --env "APP_VERSION=$version")
else
  cp "$root/live-relay-placeholder/server.js" "$stage/app/server.js"
fi

# Root-owned, world-readable, nothing writable by the app user; fixed order and times for a stable layer.
chmod -R u=rwX,go=rX "$stage/app"
"$TAR" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$stage" -cf "$stage/layer.tar" app

dest=(--output "$output")
[ -z "$tag" ] || dest=(--tag "$tag")
"$CRANE" mutate "$base" --platform linux/amd64 --append "$stage/layer.tar" "${env[@]}" \
  --workdir /app --user node --cmd node,server.js --exposed-ports 8080/tcp "${dest[@]}"
