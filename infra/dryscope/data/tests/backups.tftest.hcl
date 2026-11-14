# Mocked checks for the 35-day backup window (D-023; docs/plans/TC.md, TC-9). Nothing here reaches
# Google Cloud. Run with the rest of the suite, once per environment:
#   terraform test -var-file=envs/test.tfvars
#   terraform test -var-file=envs/live.tfvars

mock_provider "google" {}

run "evidence_keeps_deleted_versions_28_days_then_7_of_soft_delete" {
  command = plan

  assert {
    condition     = google_storage_bucket.evidence.soft_delete_policy[0].retention_duration_seconds == 7 * 86400
    error_message = "Soft delete is 7 days in every environment."
  }
  assert {
    condition     = length(google_storage_bucket.evidence.lifecycle_rule) == 1
    error_message = "The noncurrent-version rule is the bucket's only lifecycle rule."
  }
  assert {
    condition     = one(google_storage_bucket.evidence.lifecycle_rule[0].condition).days_since_noncurrent_time == 28 && one(google_storage_bucket.evidence.lifecycle_rule[0].condition).with_state == "ARCHIVED" && one(google_storage_bucket.evidence.lifecycle_rule[0].action).type == "Delete"
    error_message = "Noncurrent versions are deleted 28 days after they stop being live, and only noncurrent versions."
  }
  assert {
    condition     = google_storage_bucket.evidence.versioning[0].enabled == true
    error_message = "Versioning stays on, so a deleted object is kept as a noncurrent version first."
  }
}

run "cloud_sql_keeps_at_most_30_backups" {
  command = plan

  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups <= 30 && google_sql_database_instance.main.settings[0].backup_configuration[0].backup_retention_settings[0].retention_unit == "COUNT"
    error_message = "Cloud SQL keeps at most 30 daily backups."
  }
}

run "the_field_database_is_backed_up_daily_and_kept_14_days" {
  command = plan

  assert {
    condition     = google_firestore_backup_schedule.field_daily.database == "dryscope-field-${var.environment}" && google_firestore_backup_schedule.field_daily.project == "dryscope"
    error_message = "The schedule backs up this environment's field database."
  }
  assert {
    condition     = google_firestore_backup_schedule.field_daily.retention == "1209600s"
    error_message = "Each backup is kept 14 days."
  }
  assert {
    condition     = length(google_firestore_backup_schedule.field_daily.daily_recurrence) == 1 && length(google_firestore_backup_schedule.field_daily.weekly_recurrence) == 0
    error_message = "The schedule runs daily."
  }
}

run "a_soft_delete_above_7_days_is_refused" {
  command = plan

  variables {
    evidence_soft_delete_days = 8
  }

  expect_failures = [var.evidence_soft_delete_days]
}

run "the_old_30_day_live_soft_delete_is_refused" {
  command = plan

  variables {
    evidence_soft_delete_days = 30
  }

  expect_failures = [var.evidence_soft_delete_days]
}

run "more_than_30_cloud_sql_backups_is_refused" {
  command = plan

  variables {
    sql_backup_retained_count = 31
  }

  expect_failures = [var.sql_backup_retained_count]
}

run "exactly_30_cloud_sql_backups_is_accepted" {
  command = plan

  variables {
    sql_backup_retained_count = 30
  }

  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 30
    error_message = "30 retained backups is the limit and is accepted."
  }
}
