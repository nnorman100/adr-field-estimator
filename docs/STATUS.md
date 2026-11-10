# Status

One table of truth for each feature, split by stage into the files under `docs/status/`: **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Last built from `docs/roadmap.md` and `RELEASES.md` on 2026-10-28. `RELEASES.md` stays the only record of what is serving; recheck it, do not copy from here.

Legend: yes · no · partial · flag off. "no" under Phone-checked means no phone check is recorded in the repo; the roadmap says releases since Oct 19 were checked signed-out only.

This file replaces the roadmap's old "Where we are" narrative. Do not edit `docs/status/` in feature PRs: status is updated in one batch after merges. Keep `docs/roadmap.md` for the plan.

- [Current app (Python backend and `public/`)](status/current-app.md)
- [Company price books, pricing v2 and estimate assist](status/pricing.md)
- [S1 central Terraform](status/s1-terraform.md)
- [S2 test release path](status/s2-release-path.md)
- [S2 TypeScript app skeleton](status/s2-typescript-skeleton.md)
- [S4 TypeScript pricing engine](status/s4-pricing-engine.md)
- [Not built, open items and next steps](status/open-items.md)
