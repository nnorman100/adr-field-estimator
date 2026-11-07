# Mocked checks for the data root. Nothing here reaches Google Cloud: the mock
# provider answers every call. Run once per environment:
#   terraform test -var-file=envs/test.tfvars
#   terraform test -var-file=envs/live.tfvars

mock_provider "google" {}

run "cloud_sql_is_protected_dedicated_and_recoverable" {
  command = plan

  assert {
    condition     = google_sql_database_instance.main.deletion_protection == true
    error_message = "Terraform deletion protection must be on."
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].deletion_protection_enabled == true
    error_message = "Cloud SQL deletion protection must be on."
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].availability_type == "ZONAL"
    error_message = "The pilot instance is zonal."
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].enabled == true
    error_message = "Automated backups must be on."
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].backup_configuration[0].point_in_time_recovery_enabled == true
    error_message = "Point-in-time recovery must be on."
  }
  assert {
    condition     = google_sql_database_instance.main.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "TLS must be required."
  }
  assert {
    condition     = length(google_sql_database_instance.main.settings[0].ip_configuration[0].authorized_networks) == 0
    error_message = "No network may be authorized to reach the instance directly."
  }
  assert {
    condition     = google_sql_database_instance.main.region == "us-central1"
    error_message = "The instance must be in us-central1."
  }
  assert {
    condition     = (var.environment == "live") == startswith(google_sql_database_instance.main.settings[0].tier, "db-custom-")
    error_message = "Live uses a dedicated-core tier; test may use a small one."
  }
}

run "no_built_in_database_password_user" {
  command = plan

  assert {
    condition     = alltrue([for u in google_sql_user.iam : u.type == "CLOUD_IAM_SERVICE_ACCOUNT"])
    error_message = "Database users must be IAM service accounts, never password users."
  }
}

run "firestore_is_a_separate_named_protected_database" {
  command = plan

  assert {
    condition     = google_firestore_database.field.name == "dryscope-field-${var.environment}"
    error_message = "The database must be the environment's named database."
  }
  assert {
    condition     = google_firestore_database.field.location_id == "us-central1"
    error_message = "The named database must be in us-central1."
  }
  assert {
    condition     = google_firestore_database.field.delete_protection_state == "DELETE_PROTECTION_ENABLED"
    error_message = "Firestore deletion protection must be on."
  }
  assert {
    condition     = google_firestore_database.field.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_ENABLED"
    error_message = "Firestore point-in-time recovery must be on."
  }
  assert {
    condition     = google_firestore_database.field.deletion_policy == "ABANDON"
    error_message = "Removing the resource must never delete the database."
  }
}

run "evidence_bucket_is_private_versioned_and_not_the_legacy_bucket" {
  command = plan

  assert {
    condition     = google_storage_bucket.evidence.uniform_bucket_level_access == true
    error_message = "Uniform bucket-level access must be on."
  }
  assert {
    condition     = google_storage_bucket.evidence.public_access_prevention == "enforced"
    error_message = "Public access must be prevented."
  }
  assert {
    condition     = google_storage_bucket.evidence.versioning[0].enabled == true
    error_message = "Versioning must be on."
  }
  assert {
    condition     = google_storage_bucket.evidence.force_destroy == false
    error_message = "The bucket must never be force-destroyed."
  }
  assert {
    condition     = google_storage_bucket.evidence.location == "US-CENTRAL1"
    error_message = "The bucket must be in us-central1."
  }
  assert {
    condition     = google_storage_bucket.evidence.name != "alert-disaster-field-2026-evidence"
    error_message = "The legacy evidence bucket must not be managed here."
  }
  assert {
    condition     = length(google_storage_bucket.evidence.retention_policy) == 0 && length(google_storage_bucket.evidence.lifecycle_rule) == 0
    error_message = "No retention lock and no deleting lifecycle rule without the owner's approval."
  }
  assert {
    condition     = google_storage_bucket_iam_member.api_create.role == "roles/storage.objectCreator" && google_storage_bucket_iam_member.api_view.role == "roles/storage.objectViewer"
    error_message = "The runtime account may create and read evidence, never delete it."
  }
}

run "secrets_have_names_in_one_region_and_no_values" {
  command = plan

  assert {
    condition     = length(google_secret_manager_secret.app) == 4
    error_message = "Expected the four named secrets."
  }
  assert {
    condition     = alltrue([for s in google_secret_manager_secret.app : startswith(s.secret_id, "dryscope-${var.environment}-")])
    error_message = "Secret names carry the environment."
  }
  assert {
    condition     = alltrue([for s in google_secret_manager_secret.app : s.replication[0].user_managed[0].replicas[0].location == "us-central1"])
    error_message = "Secrets replicate to us-central1 only."
  }
  assert {
    condition     = alltrue([for k, a in google_secret_manager_secret_iam_member.accessor : a.role == "roles/secretmanager.secretAccessor"])
    error_message = "Runtime accounts only access secret values; they never administer them."
  }
}

run "runtime_grants_are_limited_to_this_environment" {
  command = plan

  assert {
    condition     = alltrue([for k, m in google_project_iam_member.sql_client : strcontains(m.condition[0].expression, "instances/dryscope-${var.environment}-pg")])
    error_message = "Cloud SQL client access must be conditioned on this environment's instance."
  }
  assert {
    condition     = alltrue([for k, m in google_project_iam_member.sql_login : strcontains(m.condition[0].expression, "instances/dryscope-${var.environment}-pg")])
    error_message = "Cloud SQL login must be conditioned on this environment's instance."
  }
  assert {
    condition     = alltrue([for k, m in google_project_iam_member.firestore_user : strcontains(m.condition[0].expression, "databases/dryscope-field-${var.environment}")])
    error_message = "Firestore access must be conditioned on this environment's database."
  }
  assert {
    condition     = length(google_service_account_iam_member.deploy_workload_identity) == 0
    error_message = "No workload identity binding until the owner supplies a pool."
  }
  assert {
    condition     = alltrue([for r in ["api", "live", "migrate"] : strcontains(google_service_account.runtime[r].account_id, var.environment)])
    error_message = "Every account name carries the environment."
  }
}

run "wrong_project_is_refused" {
  command = plan

  variables {
    project_id = "mitigation-project"
  }

  expect_failures = [var.project_id]
}

run "legacy_region_is_refused" {
  command = plan

  variables {
    region = "us-west2"
  }

  expect_failures = [var.region]
}

run "unknown_environment_is_refused" {
  command = plan

  variables {
    environment = "staging"
  }

  expect_failures = [var.environment]
}

run "short_backup_history_is_refused" {
  command = plan

  variables {
    sql_backup_retained_count = 1
  }

  expect_failures = [var.sql_backup_retained_count]
}
