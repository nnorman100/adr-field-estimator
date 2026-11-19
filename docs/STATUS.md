# Status

One table of truth for each feature, split by stage into the files under `docs/status/`: **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Last built from `docs/roadmap.md` and `RELEASES.md` on 2026-10-28; PRs merged from #314 to #471 (2026-11-11 to 2026-11-19) added on 2026-11-19 from their PR descriptions. The old app (off since 2026-11-10) records hand releases in `RELEASES.md` and automatic deploys in the Actions job summary; the rebuilt app's test releases are GitHub Releases marked `(test)` (see [S2 test release path](status/s2-release-path.md)). Recheck those records, do not copy from here.

Legend: yes · no · partial · flag off. "no" under Phone-checked means no phone check is recorded in the repo; the roadmap says releases since Oct 19 were checked signed-out only.

This file replaces the roadmap's old "Where we are" narrative. Do not edit `docs/status/` in feature PRs: status is updated in one batch after merges. Keep `docs/roadmap.md` for the plan.

- [Current app (Python backend and `public/`)](status/current-app.md)
- [Company price books, pricing v2 and estimate assist](status/pricing.md)
- [S1 central Terraform](status/s1-terraform.md)
- [S2 test release path](status/s2-release-path.md)
- [S2 TypeScript app skeleton](status/s2-typescript-skeleton.md)
- [S3 identity, sign-in and company separation](status/s3-identity.md)
- [S4 TypeScript pricing engine](status/s4-pricing-engine.md)
- [S5 core workflows](status/s5-core-workflows.md)
- [S6 offline work and photos](status/s6-offline.md)
- [S7 AI and live voice](status/s7-ai.md)
- [TC Technology Standard Tier 1 catch-up](status/tc-tier1.md)
- [S8 go-live](status/s8-go-live.md)
- [CI, tests and agent tooling](status/ci-and-tooling.md)
- [Not built, open items and next steps](status/open-items.md)
