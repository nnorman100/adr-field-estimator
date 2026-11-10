export { openDatabase, migrateFromConfig } from './client';
export { CompanyContextError, withCompany, type CompanyTransaction, type Database } from './tenant';
export { MigrationError, applyMigrations, migrationsDirectory, readMigrations } from './migrate';
export {
  accessProjectionOutbox,
  actors,
  auditEvents,
  authTenants,
  companies,
  companyFeatureFlags,
  invitations,
  memberships,
  migrationLedger,
  platformAdmins,
  schema,
} from './schema';
