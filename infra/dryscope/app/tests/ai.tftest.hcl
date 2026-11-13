# Mocked checks for the AI settings of the two services (cloud_run.tf; docs/plans/S7.md, step S7-2).
# Nothing here reaches Google Cloud. Run with the rest of the suite, once per environment:
#   terraform test -var-file=envs/test.tfvars -var-file=tests/images-test.tfvars
#   terraform test -var-file=envs/live.tfvars -var-file=tests/images-live.tfvars

mock_provider "google" {}

variables {
  alert_email = "alerts@example.invalid"
}

run "web_app_runs_text_ai_on_the_us_multi_region_with_this_environments_templates" {
  command = plan

  assert {
    condition = {
      for e in google_cloud_run_v2_service.svc["api"].template[0].containers[0].env : e.name => e.value
      if contains(["AI_TEXT_LOCATION", "AI_TEXT_MODEL", "AI_TRANSCRIBE_MODEL", "MODEL_ARMOR_TEXT_TEMPLATE", "MODEL_ARMOR_IMAGE_TEMPLATE"], e.name) && length(e.value_source) == 0
      } == {
      AI_TEXT_LOCATION           = "us"
      AI_TEXT_MODEL              = "gemini-3.8-flash"
      AI_TRANSCRIBE_MODEL        = "gemini-3.5-transcribe"
      MODEL_ARMOR_TEXT_TEMPLATE  = "projects/dryscope/locations/us-central1/templates/dryscope-text-${var.environment}"
      MODEL_ARMOR_IMAGE_TEMPLATE = "projects/dryscope/locations/us/templates/dryscope-image-${var.environment}"
    }
    error_message = "The web app gets text AI on the us multi-region and this environment's text (us-central1) and image (us) templates."
  }
  assert {
    condition     = length([for e in google_cloud_run_v2_service.svc["api"].template[0].containers[0].env : e if startswith(e.name, "LIVE_") || e.name == "RELAY_AUDIENCE"]) == 0
    error_message = "The web app gets none of the relay's settings."
  }
}

run "relay_runs_live_in_us_central1_and_calls_its_own_web_app" {
  command = plan

  assert {
    condition = {
      for e in google_cloud_run_v2_service.svc["live"].template[0].containers[0].env : e.name => e.value
      if contains(["LIVE_MODEL", "LIVE_LOCATION", "MODEL_ARMOR_TEXT_TEMPLATE", "API_INTERNAL_URL", "RELAY_AUDIENCE"], e.name) && length(e.value_source) == 0
      } == {
      LIVE_MODEL                = "gemini-3.8-live"
      LIVE_LOCATION             = "us-central1"
      MODEL_ARMOR_TEXT_TEMPLATE = "projects/dryscope/locations/us-central1/templates/dryscope-text-${var.environment}"
      API_INTERNAL_URL          = "https://dryscope-api-${var.environment}-570228742694.us-central1.run.app"
      RELAY_AUDIENCE            = "dryscope-${var.environment}-live"
    }
    error_message = "The relay gets the Live model in us-central1, this environment's text template, its own web app address and the dryscope-<env>-live audience."
  }
  assert {
    condition     = length([for e in google_cloud_run_v2_service.svc["live"].template[0].containers[0].env : e if startswith(e.name, "AI_") || e.name == "MODEL_ARMOR_IMAGE_TEMPLATE"]) == 0
    error_message = "The relay gets none of the web app's text or image AI settings."
  }
}

run "relay_carries_twenty_walkthroughs_an_instance_in_test" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.svc["live"].template[0].max_instance_request_concurrency == (var.environment == "test" ? 20 : 10)
    error_message = "The relay's concurrency is 20 in test (S7-2) and stays 10 in live until S7-16 measures it."
  }
}
