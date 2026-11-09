# PLACEHOLDER image for the dryscope-live-<env> Cloud Run service, pushed once by the owner for the
# first app-root apply (docs/RUNBOOK.md, "Apply the central Terraform", step 6). Stage S7 replaces it
# with the real Live relay. It answers 503 to everything and runs as the unprivileged node user.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
COPY server.js ./
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.js"]
