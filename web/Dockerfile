# Base image pin only. Nothing here is built with Docker: the self-hosted CI pool has no Docker
# daemon, so web/scripts/build-image.sh reads the FROM line below and assembles both images (the
# web app and the Live relay placeholder) onto it with crane. Keeping the pin in this file lets
# Dependabot (docker, /web) propose base updates. A glibc base, to match the Linux runner that
# builds the standalone output.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
