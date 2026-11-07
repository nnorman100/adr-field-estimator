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
      # A browser socket must keep reaching the instance holding its Live session.
      affinity = true
    }
  }

  common_env = {
    APP_ENVIRONMENT       = var.environment
    GOOGLE_CLOUD_PROJECT  = var.project_id
    GOOGLE_CLOUD_LOCATION = var.region
    FIRESTORE_DATABASE_ID = local.n.firestore_database_id
    SQL_CONNECTION_NAME   = local.n.sql_connection_name
    SQL_DATABASE_NAME     = local.n.sql_database_name
    EVIDENCE_BUCKET       = local.n.evidence_bucket
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
  ingress             = var.ingress
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
    # The deploy tooling stamps these; they are not configuration.
    ignore_changes = [client, client_version]
  }
}

# Cloud Run's own IAM cannot sit in front of a browser app, so both services take
# unauthenticated calls and verify the Firebase token themselves.
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = var.public_invoker ? google_cloud_run_v2_service.svc : {}

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The deploy account may update these two services and nothing else.
resource "google_cloud_run_v2_service_iam_member" "deploy" {
  for_each = google_cloud_run_v2_service.svc

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${local.n.service_account_emails["deploy"]}"
}
