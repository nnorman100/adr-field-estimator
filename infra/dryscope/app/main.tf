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

  image_repo = "${var.region}-docker.pkg.dev/${var.project_id}/${local.n.artifact_repository}"
}

data "google_project" "this" {
  project_id = var.project_id
}
