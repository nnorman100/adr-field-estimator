# Two Cloud Run services per environment, in us-central1. Both reach data only
# through the runtime account the data root created for them.
locals {
  services = {
    api = {
      name     = local.n.cloud_run_service_names["api"]
      image    = var.api_image
      scaling  = var.api_scaling
      affinity = false
    }
    live = {
      name    = local.n.cloud_run_service_names["live"]
      image   = var.live_image
      scaling = var.live_scaling
      # Best effort only: Cloud Run routes a browser back to the same instance while it can, but
      # instance shutdown, scaling and CPU limits break that, so a Live session's resume state
      # must live outside the instance (stage S7).
      affinity = true
    }
  }

  common_env = {
    APP_ENV               = var.environment
    GOOGLE_CLOUD_PROJECT  = var.project_id
    GOOGLE_CLOUD_LOCATION = var.region
    FIRESTORE_DATABASE_ID = local.n.firestore_database_id
    SQL_CONNECTION_NAME   = local.n.sql_connection_name
    SQL_DATABASE_NAME     = local.n.sql_database_name
    EVIDENCE_BUCKET       = local.n.evidence_bucket
    # Origins whose browser requests and Live sockets the services accept.
    ALLOWED_ORIGINS = join(",", var.allowed_origins)
  }

  # Secrets each service may read, from the same table the data root grants from.
  service_secrets = {
    for svc in keys(local.services) : svc => [
      for secret, who in local.n.secret_access : secret if contains(who, svc)
    ]
  }
}

resource "google_cloud_run_v2_service" "svc" {
  for_each = local.services

  project             = var.project_id
  name                = each.value.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  launch_stage        = "GA"
  deletion_protection = true
  labels              = local.labels

  template {
    service_account                  = local.n.service_account_emails[each.key]
    timeout                          = "${each.value.scaling.timeout_s}s"
    max_instance_request_concurrency = each.value.scaling.concurrency
    session_affinity                 = each.value.affinity

    scaling {
      min_instance_count = each.value.scaling.min_instances
      max_instance_count = each.value.scaling.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.n.sql_connection_name]
      }
    }

    containers {
      image = each.value.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = each.value.scaling.cpu
          memory = each.value.scaling.memory
        }
        cpu_idle          = each.key == "api"
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # The Postgres user this service logs in as with IAM database authentication: its account
      # email without .gserviceaccount.com. The app connects over the /cloudsql socket below.
      env {
        name  = "SQL_IAM_USER"
        value = trimsuffix(local.n.service_account_emails[each.key], ".gserviceaccount.com")
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.service_secrets[each.key])
        content {
          name = upper(replace(env.value, "-", "_"))
          value_source {
            secret_key_ref {
              secret  = "${local.n.secret_prefix}${env.value}"
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
    # One owner for what is running. Terraform creates the service with the first
    # image; releases and rollbacks go through gcloud as the deploy account, which
    # cannot run this root. Without these lines the next apply would put the
    # tfvars image and traffic back. client and client_version are stamped by tooling.
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
      traffic,
    ]
  }
}

# Cloud Run's own IAM cannot sit in front of a browser app, so both services take
# unauthenticated calls and verify the Firebase token themselves.
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = google_cloud_run_v2_service.svc

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Deploy without delete. roles/run.developer would also let the deploy account
# delete services and revisions through the API, which Terraform protection
# cannot stop. The owner reviews this role at apply time.
resource "google_project_iam_custom_role" "deploy" {
  project     = var.project_id
  role_id     = "dryscopeDeploy${title(var.environment)}"
  title       = "DryScope ${var.environment} deploy"
  description = "Deploy revisions and move traffic on the DryScope ${var.environment} Cloud Run services. No delete."
  permissions = [
    "run.configurations.get",
    "run.configurations.list",
    "run.operations.get",
    "run.operations.list",
    "run.revisions.get",
    "run.revisions.list",
    "run.routes.get",
    "run.routes.list",
    "run.services.get",
    "run.services.list",
    "run.services.update",
  ]
}

# The deploy account may update these two services and nothing else.
resource "google_cloud_run_v2_service_iam_member" "deploy" {
  for_each = google_cloud_run_v2_service.svc

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "projects/${var.project_id}/roles/${google_project_iam_custom_role.deploy.role_id}"
  member   = "serviceAccount:${local.n.service_account_emails["deploy"]}"
}
