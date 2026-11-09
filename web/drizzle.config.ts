import { defineConfig } from 'drizzle-kit';

// Drafts land in web/drizzle (gitignored). The applied source is web/migrations, and
// src/db/migrate.ts is what runs those files. Copy a reviewed draft to the next NNNN_name.sql.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
});
