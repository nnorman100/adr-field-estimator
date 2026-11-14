# Operations grants and the synthetic monitor's identity (docs/plans/TC.md, step TC-9).

# The web app sends its OpenTelemetry spans to the Telemetry API (TC-3). roles/telemetry.tracesWriter
# holds telemetry.traces.write only (documents/docs.cloud.google.com/iam/docs/roles-permissions/
# telemetry). The grant is on the project, the only place a trace is written, and carries no IAM
# condition: neither the Telemetry API nor Cloud Trace is among the services IAM Conditions can scope
# by resource (documents/docs.cloud.google.com/iam/docs/conditions-resource-attributes), and a
# condition that names a resource such a service does not report "is never interpreted as granting
# access", so it would silently drop every span. A test service can therefore write spans that sit
# beside live's in the shared project (README, "Accepted risks"). The Live relay gets the same role
# when it starts tracing, in a later step.
resource "google_project_iam_member" "traces_writer" {
  for_each = toset(["api"])

  project = var.project_id
  role    = "roles/telemetry.tracesWriter"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  depends_on = [google_service_account.runtime]
}

# A failed release writes one line to Cloud Logging for the failed-release alert (TC-8, C11 B):
# `gcloud logging write dryscope-release ...` signed in as the deploy account. roles/logging.logWriter
# holds logging.logEntries.create and logging.logEntries.route, no read (documents/docs.cloud.google.com/
# iam/docs/roles-permissions/logging). Project-wide with no condition, because a log entry has no IAM
# resource of its own to scope by. Test only: the release workflow releases to test only, and live's
# deploy account gets it with the live wiring, in a later step.
resource "google_project_iam_member" "deploy_log_writer" {
  count = var.environment == "test" ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${local.n.service_account_emails["deploy"]}"

  depends_on = [google_service_account.deploy]
}

# The synthetic monitor (TC-10 code, TC-11 function and check) runs as this account. It signs in as
# the synthetic technician of test company A, so its one permission is reading that technician's
# password from its own secret. The function's logs go to Cloud Logging from stdout, which needs no
# role. Test only: the monitor watches the test copy (C3, C4).
resource "google_service_account" "synthetic" {
  count = var.environment == "test" ? 1 : 0

  project      = var.project_id
  account_id   = local.n.service_account_ids["synthetic"]
  display_name = "DryScope ${var.environment} synthetic monitor"

  depends_on = [google_project_service.apis]
}

# The synthetic technician's password: the name only. No secret version is declared, so the value is
# never in configuration or state; the owner adds it with gcloud (docs/runbook/terraform-apply.md).
resource "google_secret_manager_secret" "synthetic_password" {
  count = var.environment == "test" ? 1 : 0

  project   = var.project_id
  secret_id = "${local.n.secret_prefix}synthetic-password"
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

# Read the value of this one secret, granted on the secret itself (resource-level IAM), so no
# condition is needed and no other secret is reachable.
resource "google_secret_manager_secret_iam_member" "synthetic_password" {
  count = var.environment == "test" ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.synthetic_password[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.n.service_account_emails["synthetic"]}"

  depends_on = [google_service_account.synthetic]
}
