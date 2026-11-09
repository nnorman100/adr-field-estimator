project_id  = "dryscope"
region      = "us-central1"
environment = "live"

api_scaling = {
  min_instances = 1
  max_instances = 10
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 40
  timeout_s     = 300
}

live_scaling = {
  min_instances = 1
  max_instances = 10
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 10
  timeout_s     = 3600
}

uptime_check_enabled = true
