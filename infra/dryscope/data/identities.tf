# Runtime accounts: one per service per environment, so a test service can never
# reach live data. Grants are scoped to this environment's own resources.
resource "google_service_account" "runtime" {
  for_each = {
    api     = "DryScope ${var.environment} web and API runtime"
    live    = "DryScope ${var.environment} Live relay runtime"
    migrate = "DryScope ${var.environment} schema migrator"
  }

  project      = var.project_id
  account_id   = local.n.service_account_ids[each.key]
  display_name = each.value

  depends_on = [google_project_service.apis]
}

# Deploy account: updates this environment's Cloud Run services and pushes its
# images. It holds no data access.
resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = local.n.service_account_ids["deploy"]
  display_name = "DryScope ${var.environment} deploy"

  depends_on = [google_project_service.apis]
}

# Connect to this environment's SQL instance and nothing else.
resource "google_project_iam_member" "sql_client" {
  for_each = google_service_account.runtime

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${each.value.email}"

  condition {
    title       = "dryscope-${var.environment}-sql-only"
    description = "Only the ${var.environment} DryScope instance."
    expression  = local.sql_condition
  }
}

resource "google_project_iam_member" "sql_login" {
  for_each = google_service_account.runtime

  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${each.value.email}"

  condition {
    title       = "dryscope-${var.environment}-sql-login-only"
    description = "IAM database login on the ${var.environment} DryScope instance only."
    expression  = local.sql_condition
  }
}

# Read and write this environment's named Firestore database only. The relay
# keeps Live checkpoints there; the migrator does not touch Firestore.
resource "google_project_iam_member" "firestore_user" {
  for_each = toset(["api", "live"])

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"

  condition {
    title       = "dryscope-${var.environment}-firestore-only"
    description = "Only the dryscope-field-${var.environment} database."
    expression  = local.fs_condition
  }
}

# Gemini calls. Vertex AI cannot be scoped to one environment, so this one
# project-level grant is deliberate and reviewed.
resource "google_project_iam_member" "vertex_user" {
  for_each = toset(["api", "live"])

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# The deploy account may act as the two services' runtime accounts, no others.
resource "google_service_account_iam_member" "deploy_acts_as" {
  for_each = toset(["api", "live"])

  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# Keyless GitHub Actions: only after the owner creates the pool and passes its
# principalSet. Nothing is bound until then.
resource "google_service_account_iam_member" "deploy_workload_identity" {
  count = var.workload_identity_principal_set == "" ? 0 : 1

  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = var.workload_identity_principal_set
}
