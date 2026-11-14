# Single source of resource names and identities for the data and app roots.
#
# The two roots keep separate state, so they cannot read each other's outputs.
# Both call this module instead, which keeps every name identical in both places.
# Every name carries the environment, in dedicated project `dryscope`, and none
# collides with the legacy `alert-disaster-field-2026` us-west2 resources (Cloud
# Run `alert-disaster-field-estimator`, bucket `alert-disaster-field-2026-evidence`,
# the `(default)` Firestore database, or the `adr-runtime` and `adr-builder`
# accounts).

variable "project_id" {
  type        = string
  description = "Project that holds every DryScope resource."

  validation {
    condition     = var.project_id == "dryscope"
    error_message = "This module only names resources in project dryscope."
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
    # Calls the internal job routes on a schedule (web/src/lib/auth/service-caller.ts accepts this
    # account only). It holds no role.
    scheduler = "dryscope-scheduler-${local.env}"
    # Runs the manual AI evaluation workflow (docs/plans/S7.md, V9 B): predict and Model Armor
    # sanitize only. Test only.
    eval = "dryscope-eval-${local.env}"
    # Runs the test copy's synthetic monitor (docs/plans/TC.md, TC-9 and TC-11): reads its own
    # sign-in password secret and nothing else. Test only.
    synthetic = "dryscope-synthetic-${local.env}"
  }

  # Fixed by the project_id check above; Cloud Run's deterministic address uses it.
  project_number = "570228742694"
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
  description = "Named database for field drafts; the legacy default database in alert-disaster-field-2026 is never touched."
  value       = "dryscope-field-${local.env}"
}

output "evidence_bucket" {
  value = "${var.project_id}-evidence-${local.env}"
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

output "api_url" {
  description = "The web app's deterministic Cloud Run address (SERVICE-PROJECT_NUMBER.REGION.run.app), the same one allowed_origins names."
  value       = "https://dryscope-api-${local.env}-${local.project_number}.us-central1.run.app"
}

# Internal job routes the scheduler calls (serviceRoute in web/src/lib/auth/route.ts). Each job's
# token audience is dryscope-<env>-<job>, the audience service-caller.ts checks.
output "scheduled_jobs" {
  value = {
    access-projection = {
      name     = "dryscope-access-projection-${local.env}"
      path     = "/api/internal/access-projection"
      audience = "dryscope-${local.env}-access-projection"
    }
  }
}

# Model Armor templates the services screen AI text and images with (docs/plans/S7.md, S7-2 and V3).
# The text template is Terraform's (data root, ai.tf), in us-central1. The image template is in the
# us multi-region and is created by the owner (the provider has no image-modality field).
output "model_armor_templates" {
  value = {
    text  = "projects/${var.project_id}/locations/us-central1/templates/dryscope-text-${local.env}"
    image = "projects/${var.project_id}/locations/us/templates/dryscope-image-${local.env}"
  }
}

# The audience the Live relay's Google ID token carries when it calls the web app's relay routes
# (relayRoute, docs/plans/S7.md section 4.1): dryscope-<env>-live.
output "relay_audience" {
  value = "dryscope-${local.env}-live"
}

output "cloud_run_job_names" {
  description = "Cloud Run jobs. The migration job runs numbered migrations as the migrator before a release moves traffic."
  value = {
    migrate = "dryscope-migrate-${local.env}"
  }
}
