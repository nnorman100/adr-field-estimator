project_id  = "alert-disaster-field-2026"
region      = "us-central1"
environment = "test"

# Scale to zero: test costs nothing while idle.
api_scaling = {
  min_instances = 0
  max_instances = 3
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 40
  timeout_s     = 300
}

live_scaling = {
  min_instances = 0
  max_instances = 2
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 10
  timeout_s     = 3600
}

uptime_check_enabled = false
