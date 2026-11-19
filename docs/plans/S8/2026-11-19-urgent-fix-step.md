# S8 plan, correction, 2026-11-19: urgent-fix step S8-25

Part of [the S8 plan](../S8.md), section 15.

The build-practice audit against the Technology Standard (2026-11-19) found that the Standard's Core release path asks for an urgent-fix workflow ("a manual-only workflow deploys a new image straight to Cloud Run with no infrastructure changes; the same release then goes through the normal path") and that no plan named one. `.github/workflows/web-release.yml` is the only release workflow for the rebuilt app and reaches test only (`web-release.yml:1-19`).

Section 5 of [the S8 plan](../S8.md) now lists [S8-25](S8-25.md), and section 6 places it in wave D. Section 6's order for release workflows becomes S8-14, S8-18, S8-19, then S8-25. S8-25 must be merged and approved before switch-over day: wave G, [S8-24](S8-24.md)'s "Needs" and section 4.4 say so. S8-25 has one input, a commit on `master`, and no environment selector: it promotes one image digest to test and then, after test passed on that digest, to live, reusing the release lock, drain check, serving-address check and traffic put-back of S8-18 and S8-19 by reference; the normal release of the same version then reuses that digest. No other step file changes besides S8-24's "Needs" line, and no code, workflow or Terraform changes; the workflow itself is built and approved in its own pull request.
