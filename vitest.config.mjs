import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/test_required_docs.js',
      'tests/test_ai_inventory.js',
      'tests/test_terraform_plan_check.js',
      'tests/test_terraform_plan_check_identity.js',
      'tests/test_terraform_plan_check_migrate_job.js',
      'tests/test_terraform_plan_check_scheduler_rules.js',
      'tests/test_file_length_limit.ts',
      'tests/test_ci_workflows.ts',
      'tests/test_web_release_workflow.ts',
      'tests/test_web_images.ts',
      'tests/test_test_guard.ts',
    ],
  },
});
