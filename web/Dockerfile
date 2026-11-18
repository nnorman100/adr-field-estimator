# Base image pin only. Nothing here is built with Docker: the self-hosted CI pool has no Docker
# daemon, so web/scripts/build-image.sh reads the FROM line below and assembles both images (the
# web app and the Live relay placeholder) onto it with crane. Keeping the pin in this file lets
# Dependabot (docker, /web) propose base updates. A glibc base, to match the Linux runner that
# builds the standalone output.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
