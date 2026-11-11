# Scheduled calls to the web app's internal job routes. Each one POSTs to the job's route on the
# web app's deterministic address with a Google-signed ID token for the scheduler account
# (dryscope-scheduler-<env>, data root) whose audience is dryscope-<env>-<job>: exactly the caller
# and audience serviceRoute accepts (web/src/lib/auth/service-caller.ts). The scheduler account
# needs no role on the service, which takes unauthenticated calls (cloud_run.tf); the route
# itself refuses every other token.
#
# access-projection: one outbox pass that writes or removes waiting Firestore access records and
# retries failed ones (S3-12). Passes are safe to overlap (the outbox takes a lock), and a failed
# pass is not retried: the next one runs five minutes later.
resource "google_cloud_scheduler_job" "jobs" {
  for_each = local.n.scheduled_jobs

  project          = var.project_id
  region           = var.region
  name             = each.value.name
  description      = "DryScope ${var.environment}: POST ${each.value.path} as the scheduler account."
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"
  paused           = false

  http_target {
    http_method = "POST"
    uri         = "${local.n.api_url}${each.value.path}"

    oidc_token {
      service_account_email = local.n.service_account_emails["scheduler"]
      audience              = each.value.audience
    }
  }
}
