# Image repository per environment. It lives in the data root so the first image
# can be pushed before the app root creates Cloud Run services.
# No cleanup policy: deleting images is a separate, owner-approved decision.
resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = local.n.artifact_repository
  format        = "DOCKER"
  description   = "DryScope ${var.environment} images, deployed by digest."
  labels        = local.labels

  docker_config {
    immutable_tags = true
  }

  # Container scanning (docs/plans/TC.md, C5 A): follow the project's Container Scanning API, which
  # this root turns on, so every new image is scanned once on push. Set explicitly so a repository
  # switched to DISABLED by hand comes back in the next plan.
  vulnerability_scanning_config {
    enablement_config = "INHERITED"
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "deploy_write" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${local.n.service_account_emails["deploy"]}"

  depends_on = [google_service_account.deploy]
}
