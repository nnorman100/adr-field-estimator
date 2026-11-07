# Alerts for this environment. Email is the only channel; the address comes from
# a sensitive variable, so it is never in git.
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "DryScope ${var.environment} alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "server_errors" {
  for_each = google_cloud_run_v2_service.svc

  project               = var.project_id
  display_name          = "DryScope ${var.environment}: ${each.value.name} server errors"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.id]
  user_labels           = local.labels

  conditions {
    display_name = "More than 5 responses with a 5xx status in 10 minutes"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${each.value.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"

      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Open the service in Cloud Run (us-central1) and read its latest revision logs. Roll traffic back if this began with a deploy."
  }
}

resource "google_monitoring_alert_policy" "api_latency" {
  project               = var.project_id
  display_name          = "DryScope ${var.environment}: web app slow"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.id]
  user_labels           = local.labels

  conditions {
    display_name = "p95 request latency above ${var.latency_p95_ms} ms for 10 minutes"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${local.n.cloud_run_service_names["api"]}\" AND metric.type = \"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.latency_p95_ms
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }
}

# Cloud SQL pressure.
resource "google_monitoring_alert_policy" "sql" {
  for_each = {
    cpu  = { metric = "cloudsql.googleapis.com/database/cpu/utilization", threshold = 0.8, duration = "900s", label = "CPU above 80% for 15 minutes" }
    disk = { metric = "cloudsql.googleapis.com/database/disk/utilization", threshold = 0.85, duration = "300s", label = "disk above 85% full" }
  }

  project               = var.project_id
  display_name          = "DryScope ${var.environment}: database ${each.key}"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.id]
  user_labels           = local.labels

  conditions {
    display_name = each.value.label
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.n.sql_connection_name}\" AND metric.type = \"${each.value.metric}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = each.value.duration

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
}

# Health probe through the real public path. Off in test so the service can
# stay at zero instances.
resource "google_monitoring_uptime_check_config" "api_health" {
  count = var.uptime_check_enabled ? 1 : 0

  project      = var.project_id
  display_name = "DryScope ${var.environment}: web app health"
  period       = "300s"
  timeout      = "10s"

  http_check {
    path           = "/api/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(google_cloud_run_v2_service.svc["api"].uri, "https://")
    }
  }
}

resource "google_monitoring_alert_policy" "api_down" {
  count = var.uptime_check_enabled ? 1 : 0

  project               = var.project_id
  display_name          = "DryScope ${var.environment}: health check failing"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.id]
  user_labels           = local.labels

  conditions {
    display_name = "Health check fails from at least two regions"
    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${google_monitoring_uptime_check_config.api_health[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "60s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }
}
