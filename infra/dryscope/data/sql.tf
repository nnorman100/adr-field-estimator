# Cloud SQL for PostgreSQL: one zonal ENTERPRISE instance per environment
# (shared-core db-f1-micro in test; dedicated db-custom-1-3840 in live).
# Official records (companies, prices, submitted snapshots, signatures) live here.
#
# Access is by IAM database authentication only. No built-in password user is
# created, so no password reaches state. Row-level security, the non-owner runtime
# role and the migrator role's grants belong to numbered migrations, not Terraform.
resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = local.n.sql_instance_name
  region              = var.region
  database_version    = var.sql_database_version
  deletion_protection = true

  settings {
    edition                     = "ENTERPRISE"
    tier                        = var.sql_tier
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.sql_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = true
    user_labels                 = local.labels

    backup_configuration {
      enabled                        = true
      start_time                     = "09:00"
      location                       = var.region
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.sql_pitr_log_days

      backup_retention_settings {
        retained_backups = var.sql_backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    # Reached only through the Cloud SQL connector on Cloud Run: no authorized
    # networks, TLS required. Private IP needs a VPC and is an open owner decision.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    insights_config {
      query_insights_enabled = true
    }

    maintenance_window {
      day          = 7
      hour         = 10
      update_track = "stable"
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = local.n.sql_database_name

  # Never drop the database if the resource is removed from configuration.
  deletion_policy = "ABANDON"
}

# IAM service-account users. Postgres limits names, so the suffix is trimmed.
resource "google_sql_user" "iam" {
  for_each = toset(["api", "live", "migrate"])

  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = trimsuffix(local.n.service_account_emails[each.key], ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"

  deletion_policy = "ABANDON"

  depends_on = [google_service_account.runtime]
}
