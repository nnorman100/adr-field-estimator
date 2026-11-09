import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Typed view of web/migrations. The SQL files are what the ledger applies; this module only reads
// and writes those tables. Sign-in, permissions, prices and row-level security are later stages.

export const migrationLedger = pgTable('migration_ledger', {
  id: text('id').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const schema = { migrationLedger, companies };
