# Architecture: Project profile

Part of [Architecture](../ARCHITECTURE.md).

## Project profile

Technology Standard profile (the standard itself is the owner's; this block records only what is specific to DryScope).

| Item                | Value                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Project             | DryScope: a phone web app where a restoration technician walks a water or mold loss once and leaves with a priced, signable estimate |
| Google Cloud project | `dryscope` (project number `570228742694`) is the test environment's project, region `us-central1`. The standard gives each environment its own project (D-018), so the live project is created before S8; live has no resources yet. The current Python app stays in `alert-disaster-field-2026` (`us-west2`) until the rebuilt app is live |
| Modules on          | A (multi-company), B (offline field capture), C (voice and long-running services), E (AI search), F (agents)           |
| Recorded exceptions | See [Decision log](../DECISIONS.md): D-013 (build server and CI runner), D-014 (agent limit), D-015 (pipeline reviewer, superseded by D-029), D-036 (Terraform plan and apply run by hand), D-037 (CodeQL not on pull requests), D-038 (no automatic review fixes), D-039 (thinner release smoke check) |
| Agent limit         | May use every available agent (owner, Nov 6, 2026), instead of the standard's three                                    |
| Standard version    | Aligned to 2.10 (approved by the owner Nov 13, 2026), plus the 2.11 builder and reviewer rule (D-029) and the 2.13 browser-test, protected-path, Dependabot and agent-hook practices. The Standard is at 2.13 (Nov 17, 2026). Not yet reflected: the 2.13 `DESIGN.md` lint (`npx @google/design.md lint`) and the image repository cleanup policy (a 2.10 item, planned in S8). Checked by the standards audit of Nov 19, 2026 |
