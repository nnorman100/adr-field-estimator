// The S7-5 evaluation suites, one per AI feature (docs/plans/S7.md, S7-5). Dependency-free, so the
// workflow guard (tests/test_ai_evals_workflow.ts) checks the manual workflow offers exactly these.
export const SUITES = ['summary', 'job_summary', 'scope_fill', 'injection', 'meter_reading', 'voice_notes', 'live'] as const;
export type Suite = (typeof SUITES)[number];
export const isSuite = (value: unknown): value is Suite => (SUITES as readonly unknown[]).includes(value);
