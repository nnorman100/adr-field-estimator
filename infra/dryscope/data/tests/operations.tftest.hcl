# Mocked checks for the TC-9 data-root bundle (docs/plans/TC.md): the stage's APIs, the trace and log
# writer grants, the synthetic monitor's account and secret, container scanning, the reCAPTCHA key,
# App Check, and keyless sign-in by numeric repository id only (D-024). Nothing here reaches Google
# Cloud. Run with the rest of the suite, once per environment:
#   terraform test -var-file=envs/test.tfvars
#   terraform test -var-file=envs/live.tfvars

mock_provider "google" {}

run "the_stage_apis_are_enabled_and_never_switched_off" {
  command = plan

  assert {
    condition = alltrue([for api in [
      "billingbudgets.googleapis.com",
      "cloudbuild.googleapis.com",
      "clouderrorreporting.googleapis.com",
      "cloudfunctions.googleapis.com",
      "cloudtrace.googleapis.com",
      "containerscanning.googleapis.com",
      "firebaseappcheck.googleapis.com",
      "monitoring.googleapis.com",
      "recaptchaenterprise.googleapis.com",
      "run.googleapis.com",
      "telemetry.googleapis.com",
    ] : contains(keys(google_project_service.apis), api)])
    error_message = "Every API stage TC needs is in the list."
  }
  assert {
    condition     = alltrue([for a in google_project_service.apis : a.disable_on_destroy == false && a.disable_dependent_services == false && a.project == "dryscope"])
    error_message = "No API is ever switched off by this root."
  }
}

run "the_web_app_writes_traces_and_nothing_else_new" {
  command = plan

  assert {
    condition     = toset(keys(google_project_iam_member.traces_writer)) == toset(["api"])
    error_message = "Only the web app writes traces for now."
  }
  assert {
    condition     = google_project_iam_member.traces_writer["api"].role == "roles/telemetry.tracesWriter" && google_project_iam_member.traces_writer["api"].member == "serviceAccount:dryscope-api-${var.environment}@dryscope.iam.gserviceaccount.com" && google_project_iam_member.traces_writer["api"].project == "dryscope"
    error_message = "Trace writing is roles/telemetry.tracesWriter for this environment's web app account, on project dryscope."
  }
  assert {
    condition     = length(google_project_iam_member.traces_writer["api"].condition) == 0
    error_message = "The Telemetry API takes no IAM resource condition; one would silently drop every span."
  }
}

run "only_the_test_deploy_account_writes_the_release_line" {
  command = plan

  assert {
    condition     = length(google_project_iam_member.deploy_log_writer) == (var.environment == "test" ? 1 : 0)
    error_message = "The release workflow releases to test only, so only test's deploy account writes logs."
  }
  assert {
    condition     = alltrue([for m in google_project_iam_member.deploy_log_writer : m.role == "roles/logging.logWriter" && m.member == "serviceAccount:dryscope-deploy-test@dryscope.iam.gserviceaccount.com" && length(m.condition) == 0])
    error_message = "The deploy account holds Logs Writer, nothing broader."
  }
}

run "the_synthetic_monitor_reads_its_own_password_only_in_test" {
  command = plan

  assert {
    condition     = length(google_service_account.synthetic) == (var.environment == "test" ? 1 : 0) && length(google_secret_manager_secret.synthetic_password) == length(google_service_account.synthetic) && length(google_secret_manager_secret_iam_member.synthetic_password) == length(google_service_account.synthetic)
    error_message = "The synthetic monitor's account, secret and grant exist in test only."
  }
  assert {
    condition     = alltrue([for a in google_service_account.synthetic : a.account_id == "dryscope-synthetic-test"])
    error_message = "The account is dryscope-synthetic-test."
  }
  assert {
    condition     = alltrue([for s in google_secret_manager_secret.synthetic_password : s.secret_id == "dryscope-test-synthetic-password" && s.replication[0].user_managed[0].replicas[0].location == "us-central1" && length(s.replication[0].user_managed[0].replicas) == 1])
    error_message = "The secret is dryscope-test-synthetic-password, kept in us-central1 only."
  }
  assert {
    condition     = alltrue([for m in google_secret_manager_secret_iam_member.synthetic_password : m.role == "roles/secretmanager.secretAccessor" && m.member == "serviceAccount:dryscope-synthetic-test@dryscope.iam.gserviceaccount.com" && m.secret_id == "dryscope-test-synthetic-password" && length(m.condition) == 0])
    error_message = "Only the synthetic account reads the value, on that one secret."
  }
  assert {
    condition     = !contains(keys(google_secret_manager_secret_iam_member.accessor), "synthetic-password/synthetic")
    error_message = "No service account of the app reads the synthetic password."
  }
}

run "the_image_repository_follows_project_scanning" {
  command = plan

  assert {
    condition     = google_artifact_registry_repository.images.vulnerability_scanning_config[0].enablement_config == "INHERITED"
    error_message = "Scanning is set explicitly to follow the project's Container Scanning API."
  }
}

run "the_recaptcha_key_scores_this_environments_host_only" {
  command = plan

  assert {
    condition     = google_recaptcha_enterprise_key.web.project == "dryscope" && google_recaptcha_enterprise_key.web.deletion_policy == "PREVENT"
    error_message = "The key is in project dryscope and the provider refuses to delete it."
  }
  assert {
    condition     = google_recaptcha_enterprise_key.web.web_settings[0].integration_type == "SCORE"
    error_message = "A score-only website key: no checkbox, no challenge."
  }
  assert {
    condition     = google_recaptcha_enterprise_key.web.web_settings[0].allowed_domains == tolist(["dryscope-api-${var.environment}-570228742694.us-central1.run.app"])
    error_message = "The key is allowed on this environment's app host only."
  }
  assert {
    condition     = alltrue([for d in google_recaptcha_enterprise_key.web.web_settings[0].allowed_domains : !strcontains(d, "*") && !strcontains(lower(d), "localhost") && !strcontains(d, "127.0.0.1") && !strcontains(d, "/") && !strcontains(d, ":")])
    error_message = "No wildcard, localhost, path or port in the key's domains."
  }
  assert {
    condition     = google_recaptcha_enterprise_key.web.web_settings[0].allow_all_domains == false && google_recaptcha_enterprise_key.web.web_settings[0].allow_amp_traffic == false
    error_message = "The domain list is enforced and AMP pages are not admitted."
  }
  assert {
    condition     = length(google_recaptcha_enterprise_key.web.testing_options) == 0 && length(google_recaptcha_enterprise_key.web.android_settings) == 0 && length(google_recaptcha_enterprise_key.web.ios_settings) == 0 && length(google_recaptcha_enterprise_key.web.waf_settings) == 0
    error_message = "A web key only, with no fixed testing score."
  }
}

run "app_check_waits_for_the_web_app_id" {
  command = plan

  assert {
    condition     = length(google_firebase_app_check_recaptcha_enterprise_config.web) == 0
    error_message = "No App Check registration until the owner passes the web app id."
  }
}

run "app_check_registers_the_web_app_with_the_key" {
  command = plan

  variables {
    app_check_web_app_id = "1:570228742694:web:0123456789abcdef"
  }

  assert {
    condition     = length(google_firebase_app_check_recaptcha_enterprise_config.web) == 1
    error_message = "The web app id registers App Check once."
  }
  assert {
    condition     = google_firebase_app_check_recaptcha_enterprise_config.web[0].app_id == var.app_check_web_app_id && google_firebase_app_check_recaptcha_enterprise_config.web[0].project == "dryscope"
    error_message = "App Check is registered for the given web app in project dryscope."
  }
  assert {
    condition     = google_firebase_app_check_recaptcha_enterprise_config.web[0].token_ttl == "3600s"
    error_message = "App Check tokens live one hour."
  }
}

run "a_web_app_id_of_another_project_is_refused" {
  command = plan

  variables {
    app_check_web_app_id = "1:123456789012:web:0123456789abcdef"
  }

  expect_failures = [var.app_check_web_app_id]
}

run "an_android_app_id_is_refused" {
  command = plan

  variables {
    app_check_web_app_id = "1:570228742694:android:0123456789abcdef"
  }

  expect_failures = [var.app_check_web_app_id]
}

# D-024: GitHub keyless sign-in trusts the numeric repository id only.
run "the_numeric_repository_id_form_is_accepted" {
  command = plan

  variables {
    workload_identity_principal_set = "principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute.repository_id/1413863528"
  }

  assert {
    condition     = google_service_account_iam_member.deploy_workload_identity[0].member == var.workload_identity_principal_set && google_service_account_iam_member.migrate_workload_identity[0].member == var.workload_identity_principal_set
    error_message = "The numeric repository id form is bound."
  }
}

run "the_repository_name_form_is_refused" {
  command = plan

  variables {
    workload_identity_principal_set = "principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute.repository/nnorman100/adr-field-estimator"
  }

  expect_failures = [var.workload_identity_principal_set]
}

run "a_repository_id_that_is_not_a_number_is_refused" {
  command = plan

  variables {
    workload_identity_principal_set = "principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute.repository_id/nnorman100"
  }

  expect_failures = [var.workload_identity_principal_set]
}

run "a_wildcard_repository_id_is_refused" {
  command = plan

  variables {
    workload_identity_principal_set = "principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute.repository_id/*"
  }

  expect_failures = [var.workload_identity_principal_set]
}
