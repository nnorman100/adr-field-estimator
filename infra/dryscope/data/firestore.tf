# A separate named database in us-central1. The legacy (default) database in
# alert-disaster-field-2026 stays in us-west2 and is never referenced here.
resource "google_firestore_database" "field" {
  project                           = var.project_id
  name                              = local.n.firestore_database_id
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"

  # Destroying this resource only forgets it; the database is never deleted.
  deletion_policy = "ABANDON"

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# D-023, the 35-day backup window: a daily backup of the field database, each kept 14 days
# (Firestore allows up to 14 weeks: documents/firebase.google.com/docs/firestore/backups). Backups
# are billed by stored size. The plan check refuses deleting the schedule.
resource "google_firestore_backup_schedule" "field_daily" {
  project   = var.project_id
  database  = google_firestore_database.field.name
  retention = "1209600s" # 14 days

  daily_recurrence {}
}
