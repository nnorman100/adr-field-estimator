import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/test_required_docs.js',
      'tests/test_ai_inventory.js',
      'tests/test_terraform_plan_check.js',
      'tests/test_terraform_plan_check_identity.js',
      'tests/test_terraform_plan_check_migrate_job.js',
    ],
  },
});
