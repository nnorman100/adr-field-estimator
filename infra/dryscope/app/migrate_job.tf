# The migration job: numbered migrations (web/migrations) run inside Google before a release moves
# traffic, so a release never depends on the network path from the CI runner to Cloud SQL. It runs
# the web image the release ships, by digest, with `node migrate.mjs` (web/src/db/job.ts, bundled
# into the image by web/scripts/build-image.sh), as the migrator account, over Cloud Run's built-in
# Cloud SQL connection with IAM database login: the access token is the password, so there is no
# password and no secret. The release workflow (.github/workflows/web-release.yml) sets the new
# image and executes it as the deploy account; Terraform creates it and then ignores the image.
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = local.n.cloud_run_job_names["migrate"]
  location            = var.region
  launch_stage        = "GA"
  deletion_protection = true
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = local.n.service_account_emails["migrate"]
      timeout         = "600s"
      # A failed run fails the release; it is rerun, not retried behind the release's back.
      max_retries = 0

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.n.sql_connection_name]
        }
      }

      containers {
        image   = var.api_image
        command = ["node"]
        args    = ["migrate.mjs"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        # Only what the migrator reads (web/src/lib/config.ts): this environment, its instance and
        # database, and the migrator's own IAM database user. No secrets.
        env {
          name  = "APP_ENV"
          value = var.environment
        }
        env {
          name  = "SQL_CONNECTION_NAME"
          value = local.n.sql_connection_name
        }
        env {
          name  = "SQL_DATABASE_NAME"
          value = local.n.sql_database_name
        }
        env {
          name  = "SQL_IAM_USER"
          value = trimsuffix(local.n.service_account_emails["migrate"], ".gserviceaccount.com")
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
    # Releases set the image through gcloud as the deploy account; the next apply must not put
    # the tfvars image back. client and client_version are stamped by tooling.
    ignore_changes = [
      client,
      client_version,
      template[0].template[0].containers[0].image,
    ]
  }
}

# Set the image on this one job, run it, and read how the run went. No create or delete, no
# run with overrides (an execution cannot change the command, arguments or settings), no cancel
# and no IAM change. Bound on the job only, never on the project.
resource "google_project_iam_custom_role" "migrate_job" {
  project     = var.project_id
  role_id     = "dryscopeMigrateJob${title(var.environment)}"
  title       = "DryScope ${var.environment} migration job"
  description = "Set the image of the DryScope ${var.environment} migration job, execute it and read its executions. No create, delete or overrides."
  permissions = [
    "run.executions.get",
    "run.executions.list",
    "run.jobs.get",
    "run.jobs.run",
    "run.jobs.update",
    "run.tasks.get",
    "run.tasks.list",
  ]
}

resource "google_cloud_run_v2_job_iam_member" "deploy" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.migrate.name
  role     = "projects/${var.project_id}/roles/${google_project_iam_custom_role.migrate_job.role_id}"
  member   = "serviceAccount:${local.n.service_account_emails["deploy"]}"
}
