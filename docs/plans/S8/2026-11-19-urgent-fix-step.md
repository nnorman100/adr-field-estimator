# S8 plan, correction, 2026-11-19: urgent-fix step S8-25

Part of [the S8 plan](../S8.md), section 15.

The build-practice audit against the Technology Standard (2026-11-19) found that the Standard's Core release path asks for an urgent-fix workflow ("a manual-only workflow deploys a new image straight to Cloud Run with no infrastructure changes; the same release then goes through the normal path") and that no plan named one. `.github/workflows/web-release.yml` is the only release workflow for the rebuilt app and reaches test only (`web-release.yml:1-19`).

Section 5 of [the S8 plan](../S8.md) now lists [S8-25](S8-25.md), a placeholder step to be designed in its own pull request, and section 6 places it in wave D. Section 6's order for release workflows becomes S8-14, S8-18, S8-19, then S8-25. S8-25 ships before switch-over day: wave G, [S8-24](S8-24.md)'s "Needs" and section 4.4 say so. The step records only what is fixed now: it promotes the same image digest, that digest passes test before live, and it uses the normal staged live rollout. Its lock, drain, compatibility, serving-address and follow-up-release details are for that design pull request. No other step file changes besides S8-24's "Needs" line, and no code, workflow or Terraform changes.
