# Private evidence bucket: photos, originals, signatures. Not the legacy bucket.
resource "google_storage_bucket" "evidence" {
  project                     = var.project_id
  name                        = local.n.evidence_bucket
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = var.evidence_soft_delete_days * 86400
  }

  # No retention policy (an irreversible lock needs its own approval) and no
  # lifecycle rule that deletes objects or old versions.

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# Routine actors may create and read objects. objectCreator and objectViewer
# carry no delete permission. Overwrite is refused only because every evidence
# upload creates with ifGenerationMatch=0 (docs/runbook/terraform-apply.md), not by the role.
resource "google_storage_bucket_iam_member" "api_create" {
  bucket = google_storage_bucket.evidence.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${local.n.service_account_emails["api"]}"

  depends_on = [google_service_account.runtime]
}

resource "google_storage_bucket_iam_member" "api_view" {
  bucket = google_storage_bucket.evidence.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.n.service_account_emails["api"]}"

  depends_on = [google_service_account.runtime]
}
