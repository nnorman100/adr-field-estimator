# Secret Manager secrets: names only. No google_secret_manager_secret_version is
# declared, so no value is ever in configuration or state. The owner adds each
# value with gcloud (see docs/runbook/terraform-apply.md).
resource "google_secret_manager_secret" "app" {
  for_each = local.n.secret_access

  project   = var.project_id
  secret_id = "${local.n.secret_prefix}${each.key}"
  labels    = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = {
    for pair in flatten([
      for secret, services in local.n.secret_access : [
        for service in services : { key = "${secret}/${service}", secret = secret, service = service }
      ]
    ]) : pair.key => pair
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.n.service_account_emails[each.value.service]}"

  depends_on = [google_service_account.runtime]
}
