---
name: dryscope-gotchas
description: Traps that keep costing DryScope pull requests a review round, taken from saved review findings. Load before writing or reviewing code in web/, infra/dryscope/ or .github/workflows/, and before answering a review finding.
---

# DryScope gotchas

These are the mistakes reviewers keep finding in DryScope work. Each has cost at least one fix round. They are not rules to apply blindly: each says what went wrong and why, so you can judge whether your change is the same case. `AGENTS.md` holds the hard rules; nothing here repeats them.

## On every change

- **Build what the step says, all of it, and nothing else.** The reviewer reads the plan step and your task text sentence by sentence. A part you defer, narrow or swap is a finding, even when your notes disclose it. So is an option, mode, fallback, dry run, wider input or helper the step did not name. If you cannot deliver a sentence of the step, ask firstmate before you start the run. After a redesign, delete what the old design needed.
- **Do not settle what the owner has not.** A unique constraint, a default or a plan sentence can quietly decide an open question, and an applied migration cannot be edited. Record the owner's words as said: "could be good" is not "wanted".
- **Tests must run the behaviour.** A test that reads source text, workflow YAML, Terraform text or rules text passes on a comment. So does a browser test that rewrites the request to another route, and a stand-in that leaves out what the real service does. Call the handler, run the emulator or the script, use Terraform's mock-provider tests.
- **Commit test, workflow, fixture and `package.json` changes yourself, before the run.** The pipeline's automatic steps may not commit those paths (`.no-mistakes.yaml`), so the run stops for a person. When a review fix needs a regression test, write it as your own commit. Regenerate committed fixtures yourself.
- **When a fix round draws findings on its own fixes, stop patching.** The cause so far has always been state held in memory in several places. Derive it from one saved record through one function every path calls, or send the pattern to firstmate as one decision.
- **When a decision changes, change every place that states the old one.** Search `docs/`, `HANDOFF.md`, the runbooks and code comments for the old wording.

## Before you touch one of these areas

| Area | Read |
| --- | --- |
| Field app, offline work, sync, sign-out, phone storage | `field-offline.md` |
| Job access, roles, archive, signing, links, Postgres | `access-records.md` |
| Estimate documents, prices, AI calls and their checks | `documents-prices-ai.md` |
| Terraform, IAM, the release workflow, Cloud Run | `infra-release.md` |
| Workflows, the Test guard, the pipeline run itself | `tests-pipeline.md` |
