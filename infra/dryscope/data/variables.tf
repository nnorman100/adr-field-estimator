variable "project_id" {
  type        = string
  description = "The dedicated DryScope project. No other project is accepted."

  validation {
    condition     = var.project_id == "dryscope"
    error_message = "This root only manages project dryscope."
  }
}

variable "region" {
  type        = string
  description = "Central region for every new resource. Existing legacy resources are never touched."

  validation {
    condition     = var.region == "us-central1"
    error_message = "New DryScope resources live in us-central1 only."
  }
}

variable "environment" {
  type        = string
  description = "test or live."

  validation {
    condition     = contains(["test", "live"], var.environment)
    error_message = "environment must be test or live."
  }
}

variable "sql_database_version" {
  type        = string
  description = "Cloud SQL for PostgreSQL major version."
  default     = "POSTGRES_16"
}

variable "sql_tier" {
  type        = string
  description = "Cloud SQL tier: shared-core db-f1-micro in test (~$10/month, no uptime guarantee, fine for test); dedicated-core db-custom-... in live."

  validation {
    condition = (
      !contains(["test", "live"], var.environment) ||
      (var.environment == "test" && var.sql_tier == "db-f1-micro") ||
      (var.environment == "live" && startswith(var.sql_tier, "db-custom-"))
    )
    error_message = "sql_tier must be db-f1-micro in test and a dedicated-core tier (db-custom-...) in live."
  }
}

variable "sql_disk_size_gb" {
  type        = number
  description = "Initial SSD size in GB. Storage auto-resizes up only."
}

variable "sql_backup_retained_count" {
  type        = number
  description = "Number of automated backups to keep: 7 to 30 (D-023: deleted data leaves the backups within 35 days)."

  validation {
    condition     = var.sql_backup_retained_count >= 7 && var.sql_backup_retained_count <= 30
    error_message = "Keep at least 7 and at most 30 automated backups (D-023, the 35-day backup window)."
  }
}

variable "sql_pitr_log_days" {
  type        = number
  description = "Days of write-ahead logs kept for point-in-time recovery (1 to 7)."

  validation {
    condition     = var.sql_pitr_log_days >= 1 && var.sql_pitr_log_days <= 7
    error_message = "sql_pitr_log_days must be between 1 and 7."
  }
}

variable "evidence_soft_delete_days" {
  type        = number
  description = "Days a deleted evidence object stays recoverable: 7 in every environment (D-023: 28 days as a noncurrent version plus 7 of soft delete keeps the window at 35 days)."

  validation {
    condition     = var.evidence_soft_delete_days == 7
    error_message = "evidence_soft_delete_days must be 7: with the 28-day noncurrent-version rule, a longer soft delete would keep deleted evidence past the 35-day window (D-023)."
  }
}

variable "workload_identity_principal_set" {
  type        = string
  description = "Optional principalSet:// string, scoped to one repository by its numeric id (attribute.repository_id), from this environment's own GitHub Actions workload identity pool (dryscope-<environment>), allowed to impersonate the deploy account (releases) and the migrator (numbered migrations before traffic). Empty until the owner creates the pool."
  default     = ""

  # D-024: only the numeric repository id. A repository name can be deleted and registered again by
  # someone else, and the name form would then trust their workflows; the numeric id is never reused
  # (documents/docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).
  validation {
    condition = var.workload_identity_principal_set == "" || can(regex(
      "^principalSet://iam\\.googleapis\\.com/projects/[0-9]+/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute\\.repository_id/[0-9]+$",
      var.workload_identity_principal_set,
    ))
    error_message = "Pass a principalSet from this environment's own pool (dryscope-<environment>, never a pool shared with the other environment) scoped to one repository by its numeric id (attribute.repository_id/<digits>). The repository-name form (attribute.repository) is refused (D-024), and the pool-wide wildcard lets every identity in the pool impersonate the deploy account."
  }
}

variable "app_check_web_app_id" {
  type        = string
  description = "Firebase web app id (1:570228742694:web:<hex>) of this environment's own registered web app (owner step 8). Empty until the owner registers it: the App Check registration is then left out and everything else applies."
  default     = ""

  validation {
    condition     = var.app_check_web_app_id == "" || can(regex("^1:570228742694:web:[0-9a-f]+$", var.app_check_web_app_id))
    error_message = "Pass the web app id Firebase shows for this project's registered web app (1:570228742694:web:<hex>), or leave it empty."
  }
}
