# Base image pin only. Nothing here is built with Docker: the self-hosted CI pool has no Docker
# daemon, so web/scripts/build-image.sh reads the FROM line below and assembles both images (the
# web app and the Live relay placeholder) onto it with crane. Keeping the pin in this file lets
# Dependabot (docker, /web) propose base updates. A glibc base, to match the Linux runner that
# builds the standalone output.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
