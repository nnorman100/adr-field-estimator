project_id  = "dryscope"
region      = "us-central1"
environment = "test"

# The web app's deterministic Cloud Run address (SERVICE-PROJECT_NUMBER.REGION.run.app).
# Add the public front door here when the owner decides it.
allowed_origins = ["https://dryscope-api-test-570228742694.us-central1.run.app"]

# Scale to zero: test costs nothing while idle.
api_scaling = {
  min_instances = 0
  max_instances = 1 # the database connection budget (web/src/db/client.ts) fits db-f1-micro's 25
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 40
  timeout_s     = 300
}

# Concurrency 20: the relay holds sockets and moves audio, so one instance carries 20 walkthroughs
# (docs/plans/S7.md, S7-2; measured in S7-16 before live changes).
live_scaling = {
  min_instances = 0
  max_instances = 2
  cpu           = "1"
  memory        = "1Gi"
  concurrency   = 20
  timeout_s     = 3600
}

uptime_check_enabled = false
