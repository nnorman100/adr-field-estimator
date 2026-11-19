module "names" {
  source      = "../modules/naming"
  project_id  = var.project_id
  environment = var.environment
}

locals {
  n = module.names

  labels = {
    app         = "dryscope"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Resource names used in IAM conditions, so each runtime account reaches only
  # its own environment's database and instance.
  sql_condition = "resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/${var.project_id}/instances/${local.n.sql_instance_name}'"

  # The database itself, or any name under it (its documents), and nothing else.
  # The trailing slash keeps a sibling such as dryscope-field-test2 or a restored
  # copy outside the grant, and the other environment's database never matches.
  fs_database  = "projects/${var.project_id}/databases/${local.n.firestore_database_id}"
  fs_condition = "resource.name == '${local.fs_database}' || resource.name.startsWith('${local.fs_database}/')"
}

# Enabling an API that is already on changes nothing. Destroying this root never
# switches an API off, because other apps in the project may use it.
#
# Stage TC (docs/plans/TC.md, TC-9) adds: Error Reporting (TC-1), Cloud Trace and the Telemetry API
# that receives OpenTelemetry spans (TC-3), App Check and reCAPTCHA Enterprise (TC-5), Container
# Scanning (C5 A: every new image pushed to a Docker repository in the project is scanned once, at
# $0.26 an image, then watched for 30 days at no charge; billing starts when the API is on), and the
# budget, Cloud Run functions, Cloud Build, Cloud Run and Monitoring APIs the app root's TC-11 apply
# uses (the budget, the synthetic monitor's function and its alerts). Personalized Service Health
# (servicehealth.googleapis.com) is on so the app root's Google-incident alert has events to match
# (documents/docs.cloud.google.com/service-health/docs/manage-access); the API itself is free.
resource "google_project_service" "apis" {
  for_each = toset([
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbuild.googleapis.com",
    "clouderrorreporting.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudtrace.googleapis.com",
    "containerscanning.googleapis.com",
    "firebaseappcheck.googleapis.com",
    "firebaserules.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "identitytoolkit.googleapis.com",
    "modelarmor.googleapis.com",
    "monitoring.googleapis.com",
    "recaptchaenterprise.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicehealth.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "telemetry.googleapis.com",
  ])

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
