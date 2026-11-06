import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/test_required_docs.js'],
  },
});
