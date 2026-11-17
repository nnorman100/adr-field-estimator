# Workflows, the Test guard and the pipeline run

- **Protected paths stop automatic commits.** `.no-mistakes.yaml` lists them: workflows, every test and fixture directory, test runner configs, `package.json`, `web/package.json`, `AGENTS.md`, `CLAUDE.md`. If an automatic fix, document or CI step edits one, the run waits for a person and "approve" is refused. Tell a fix round what to leave alone, and make the test or workflow change yourself as a normal commit.
- **The Test guard identifies a workflow step by its job and its name, or by its first command line when it has no name.** Moving steps into a new job, changing an unnamed step's command, renaming a job, or adding an `if:` reads as a removed check. Moving `test.skip` lines into a new file reads as new skips. Add jobs and steps; do not move or rename them. Never request the `test-change-approved` label.
- **The Test guard does not look at `web/tests/` yet** (`docs/runbook/ci.md`). Nothing automatic stops you weakening a test there, so the rule is yours to keep.
- **The pipeline's Test step cannot start a database or Playwright.** Run the database or browser specs that cover your change yourself, through the test slot, and say which CI suite covers each scenario.
- **A finding can quote code from before the last fix.** Read the current code before you act on it.
- **While a run is active, the branch is the pipeline's.** No hand merge, rebase or "Update branch"; it breaks the run's push. Send a conflict fix to the run as an instruction.
- **A test that times out on a busy host is rerun unchanged** once load is low. A wait added to a test helper can hide a real lost tap.
