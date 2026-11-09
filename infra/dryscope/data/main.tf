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
  fs_condition  = "resource.name == 'projects/${var.project_id}/databases/${local.n.firestore_database_id}'"
}

# Enabling an API that is already on changes nothing. Destroying this root never
# switches an API off, because other apps in the project may use it.
resource "google_project_service" "apis" {
  for_each = toset([
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
