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
  description = "Dedicated-core tier. Both environments use a dedicated zonal instance; shared-core tiers have no SQL SLA."

  validation {
    condition     = startswith(var.sql_tier, "db-custom-")
    error_message = "sql_tier must be a dedicated-core tier (db-custom-...). Shared-core tiers are not accepted in either environment."
  }
}

variable "sql_disk_size_gb" {
  type        = number
  description = "Initial SSD size in GB. Storage auto-resizes up only."
}

variable "sql_backup_retained_count" {
  type        = number
  description = "Number of automated backups to keep."

  validation {
    condition     = var.sql_backup_retained_count >= 7
    error_message = "Keep at least 7 automated backups."
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
  description = "Days a deleted evidence object stays recoverable (7 to 90)."

  validation {
    condition     = var.evidence_soft_delete_days >= 7 && var.evidence_soft_delete_days <= 90
    error_message = "evidence_soft_delete_days must be between 7 and 90."
  }
}

variable "workload_identity_principal_set" {
  type        = string
  description = "Optional principalSet:// string, scoped to one repository, from this environment's own GitHub Actions workload identity pool (dryscope-<environment>), allowed to impersonate the deploy account. Empty until the owner creates the pool."
  default     = ""

  validation {
    condition = var.workload_identity_principal_set == "" || can(regex(
      "^principalSet://iam\\.googleapis\\.com/projects/[0-9]+/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute\\.(repository_id|repository)/[^*]+$",
      var.workload_identity_principal_set,
    ))
    error_message = "Pass a principalSet from this environment's own pool (dryscope-<environment>, never a pool shared with the other environment) scoped to one repository (attribute.repository_id or attribute.repository). The pool-wide wildcard lets every identity in the pool impersonate the deploy account."
  }
}
