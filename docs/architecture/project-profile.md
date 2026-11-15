# Architecture: Project profile

Part of [Architecture](../ARCHITECTURE.md).

## Project profile

Technology Standard profile (the standard itself is the owner's; this block records only what is specific to DryScope).

| Item                | Value                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Project             | DryScope: a phone web app where a restoration technician walks a water or mold loss once and leaves with a priced, signable estimate |
| Google Cloud project | `dryscope` (project number `570228742694`) is the test environment's project, region `us-central1`. The standard gives each environment its own project (D-018), so the live project is created before S8; live has no resources yet. The current Python app stays in `alert-disaster-field-2026` (`us-west2`) until the rebuilt app is live |
| Modules on          | A (multi-company), B (offline field capture), C (voice and long-running services), E (AI search), F (agents)           |
| Recorded exceptions | See [Decision log](../DECISIONS.md): D-013 (build server and CI runner), D-014 (agent limit), D-015 (pipeline reviewer, superseded by D-029) |
| Agent limit         | May use every available agent (owner, Nov 6, 2026), instead of the standard's three                                    |
| Standard version    | 2.10 (approved by the owner Nov 13, 2026)                                                                              |
