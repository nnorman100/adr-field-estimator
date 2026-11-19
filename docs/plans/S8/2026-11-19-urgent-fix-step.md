# S8 plan, correction, 2026-11-19: urgent-fix step S8-25

Part of [the S8 plan](../S8.md), section 15.

The build-practice audit against the Technology Standard (2026-11-19) found that the Standard's Core release path asks for an urgent-fix workflow ("a manual-only workflow deploys a new image straight to Cloud Run with no infrastructure changes; the same release then goes through the normal path") and that no plan named one. `.github/workflows/web-release.yml` is the only release workflow for the rebuilt app and reaches test only (`web-release.yml:1-19`).

Section 5 of [the S8 plan](../S8.md) now lists [S8-25](S8-25.md), and section 6 places it in wave D. Section 6's order for release workflows becomes S8-14, S8-18, S8-19, then S8-25. No other step file changes, and no code, workflow or Terraform changes; the workflow itself is built and approved in its own pull request.
