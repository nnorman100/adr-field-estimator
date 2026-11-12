import type { TestProject } from 'vitest/node';
import { startSharedDatabases } from './postgres-harness';

// One PostgreSQL for the whole `npm run test:db` run (see "One server for the whole run" in
// postgres-harness.ts): the files take their own databases from it and run in parallel.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { databases, stop } = await startSharedDatabases();
  project.provide('dryscopeDatabases', databases);
  return stop;
}
