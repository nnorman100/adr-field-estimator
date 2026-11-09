# Single source of resource names and identities for the data and app roots.
#
# The two roots keep separate state, so they cannot read each other's outputs.
# Both call this module instead, which keeps every name identical in both places.
# Every name carries the environment, and none collides with the legacy us-west2
# resources (Cloud Run `alert-disaster-field-estimator`, bucket
# `alert-disaster-field-2026-evidence`, the `(default)` Firestore database, or the
# `adr-runtime` and `adr-builder` accounts).

variable "project_id" {
  type        = string
  description = "Project that holds every DryScope resource."
}

variable "environment" {
  type        = string
  description = "test or live."

  validation {
    condition     = contains(["test", "live"], var.environment)
    error_message = "environment must be test or live."
  }
}

locals {
  env = var.environment

  # Which Cloud Run service may read which secret. Secret NAMES only: values are
  # added by the owner outside Terraform and never appear in state or git.
  secret_access = {
    "resend-api-key"    = ["api"]
    "stripe-secret-key" = ["api"]
    "maps-api-key"      = ["api"]
    "link-signing-key"  = ["api", "live"]
  }

  sa_ids = {
    api     = "dryscope-api-${local.env}"
    live    = "dryscope-live-${local.env}"
    migrate = "dryscope-migrate-${local.env}"
    deploy  = "dryscope-deploy-${local.env}"
  }
}

output "sql_instance_name" {
  value = "dryscope-${local.env}-pg"
}

output "sql_connection_name" {
  description = "project:region:instance, as the Cloud Run Cloud SQL volume expects."
  value       = "${var.project_id}:us-central1:dryscope-${local.env}-pg"
}

output "sql_database_name" {
  value = "dryscope"
}

output "firestore_database_id" {
  description = "Named database; the legacy default database stays where it is as the source."
  value       = "dryscope-field-${local.env}"
}

output "evidence_bucket" {
  value = "${var.project_id}-dryscope-evidence-${local.env}"
}

output "artifact_repository" {
  value = "dryscope-${local.env}"
}

output "secret_prefix" {
  value = "dryscope-${local.env}-"
}

output "secret_access" {
  value = local.secret_access
}

output "service_account_ids" {
  value = local.sa_ids
}

output "service_account_emails" {
  value = { for k, v in local.sa_ids : k => "${v}@${var.project_id}.iam.gserviceaccount.com" }
}

output "cloud_run_service_names" {
  value = {
    api  = "dryscope-api-${local.env}"
    live = "dryscope-live-${local.env}"
  }
}
