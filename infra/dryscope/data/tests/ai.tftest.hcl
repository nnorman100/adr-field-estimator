# Mocked checks for the AI part of the data root (ai.tf; docs/plans/S7.md, step S7-2). Nothing here
# reaches Google Cloud. Run with the rest of the suite, once per environment:
#   terraform test -var-file=envs/test.tfvars
#   terraform test -var-file=envs/live.tfvars

mock_provider "google" {}

run "model_armor_api_is_enabled" {
  command = plan

  assert {
    condition     = contains(keys(google_project_service.apis), "modelarmor.googleapis.com")
    error_message = "The Model Armor API is in the API list."
  }
}

run "text_template_screens_this_environment_and_never_logs" {
  command = plan

  assert {
    condition     = google_model_armor_template.text.template_id == "dryscope-text-${var.environment}" && google_model_armor_template.text.location == "us-central1" && google_model_armor_template.text.project == "dryscope"
    error_message = "The text template is dryscope-text-<env> in us-central1, project dryscope."
  }
  assert {
    condition     = google_model_armor_template.text.template_metadata[0].log_sanitize_operations == false && google_model_armor_template.text.template_metadata[0].log_template_operations == false
    error_message = "Model Armor template logging stays off: sanitize logging writes whole prompts and responses."
  }
  assert {
    condition     = google_model_armor_template.text.template_metadata[0].enforcement_type == "INSPECT_AND_BLOCK"
    error_message = "The template blocks what it flags."
  }
  assert {
    condition     = google_model_armor_template.text.template_metadata[0].filter_version_selector[0].version == "v3" && google_model_armor_template.text.template_metadata[0].filter_version_selector[0].alias == null
    error_message = "The filter version is pinned to v3, never an alias."
  }
  assert {
    condition     = google_model_armor_template.text.template_metadata[0].ignore_partial_invocation_failures == null
    error_message = "A failed detector is never ignored."
  }
  assert {
    condition     = google_model_armor_template.text.template_metadata[0].multi_language_detection[0].enable_multi_language_detection == true
    error_message = "Multi-language detection is on."
  }
  assert {
    condition     = google_model_armor_template.text.deletion_policy == "PREVENT"
    error_message = "The provider refuses to delete the template."
  }
}

run "text_template_has_every_filter_at_medium_and_above" {
  command = plan

  assert {
    condition = toset([
      for f in google_model_armor_template.text.filter_config[0].rai_settings[0].rai_filters : "${f.filter_type}/${f.confidence_level}"
      ]) == toset([
      "DANGEROUS/MEDIUM_AND_ABOVE",
      "HARASSMENT/MEDIUM_AND_ABOVE",
      "HATE_SPEECH/MEDIUM_AND_ABOVE",
      "SEXUALLY_EXPLICIT/MEDIUM_AND_ABOVE",
    ])
    error_message = "All four Responsible AI filters at medium and above."
  }
  assert {
    condition     = google_model_armor_template.text.filter_config[0].pi_and_jailbreak_filter_settings[0].filter_enforcement == "ENABLED" && google_model_armor_template.text.filter_config[0].pi_and_jailbreak_filter_settings[0].confidence_level == "MEDIUM_AND_ABOVE"
    error_message = "Prompt injection and jailbreak detection at medium and above."
  }
  assert {
    condition     = google_model_armor_template.text.filter_config[0].malicious_uri_filter_settings[0].filter_enforcement == "ENABLED" && google_model_armor_template.text.filter_config[0].sdp_settings[0].basic_config[0].filter_enforcement == "ENABLED"
    error_message = "Malicious URL detection and basic Sensitive Data Protection are on."
  }
}

run "floor_setting_blocks_without_logging_and_is_owned_by_test_only" {
  command = plan

  assert {
    condition     = length(google_model_armor_floorsetting.project) == (var.environment == "test" ? 1 : 0)
    error_message = "One floor setting serves the project, so only the test root manages it."
  }
  assert {
    condition = alltrue([for f in google_model_armor_floorsetting.project : (
      f.parent == "projects/dryscope" && f.location == "global" && f.enable_floor_setting_enforcement == true &&
      f.integrated_services == tolist(["AI_PLATFORM"])
    )])
    error_message = "The floor setting is project dryscope's, enforced, for Agent Platform."
  }
  assert {
    condition     = alltrue([for f in google_model_armor_floorsetting.project : f.ai_platform_floor_setting[0].inspect_and_block == true && f.ai_platform_floor_setting[0].inspect_only == null])
    error_message = "The floor setting inspects and blocks, never inspect only."
  }
  assert {
    condition     = alltrue([for f in google_model_armor_floorsetting.project : f.ai_platform_floor_setting[0].enable_cloud_logging == false])
    error_message = "Floor-setting logging stays off: it writes whole prompts and responses."
  }
  assert {
    condition     = alltrue([for f in google_model_armor_floorsetting.project : length(f.google_mcp_server_floor_setting) == 0])
    error_message = "The floor setting covers Agent Platform only."
  }
  assert {
    condition     = alltrue([for f in google_model_armor_floorsetting.project : f.filter_config == google_model_armor_template.text.filter_config])
    error_message = "The floor setting has the same filters as the text template."
  }
}

run "sanitize_access_is_one_grant_per_service_account" {
  command = plan

  assert {
    condition     = toset(keys(google_project_iam_member.modelarmor_user)) == toset(["api", "live"])
    error_message = "Only the web app and the relay screen text in both environments."
  }
  assert {
    condition = alltrue([for k, m in google_project_iam_member.modelarmor_user : (
      m.role == "roles/modelarmor.user" && m.member == "serviceAccount:dryscope-${k}-${var.environment}@dryscope.iam.gserviceaccount.com" && length(m.condition) == 0
    )])
    error_message = "Each grant names one account of this environment, with roles/modelarmor.user and no condition (Model Armor evaluates none)."
  }
}

run "evaluation_account_is_test_only_and_can_predict_and_screen_only" {
  command = plan

  assert {
    condition     = length(google_service_account.eval) == (var.environment == "test" ? 1 : 0) && alltrue([for a in google_service_account.eval : a.account_id == "dryscope-eval-test"])
    error_message = "Only test has the evaluation account, dryscope-eval-test."
  }
  assert {
    condition = var.environment == "live" ? length(google_project_iam_member.eval) == 0 : (
      google_project_iam_member.eval["predict"].role == "projects/dryscope/roles/dryscopeGeminiTest" &&
      google_project_iam_member.eval["modelarmor"].role == "roles/modelarmor.user" &&
      length(google_project_iam_member.eval) == 2
    )
    error_message = "The evaluation account holds the predict-only role and roles/modelarmor.user, in test only."
  }
  assert {
    condition     = alltrue([for m in google_project_iam_member.eval : m.member == "serviceAccount:dryscope-eval-test@dryscope.iam.gserviceaccount.com" && length(m.condition) == 0])
    error_message = "Each evaluation grant names the evaluation account only."
  }
  assert {
    condition     = length(google_service_account_iam_member.eval_workload_identity) == 0
    error_message = "No keyless binding until the owner supplies a pool."
  }
}

run "evaluation_workflow_binding_takes_tests_principal_set_on_the_eval_account" {
  command = plan

  variables {
    workload_identity_principal_set = "principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/dryscope-${var.environment}/attribute.repository_id/987654321"
  }

  assert {
    condition     = length(google_service_account_iam_member.eval_workload_identity) == (var.environment == "test" ? 1 : 0)
    error_message = "The evaluation workflow signs in on test only, even when live has a pool."
  }
  assert {
    condition = alltrue([for b in google_service_account_iam_member.eval_workload_identity : (
      b.role == "roles/iam.workloadIdentityUser" && b.member == var.workload_identity_principal_set &&
      b.service_account_id == "projects/dryscope/serviceAccounts/dryscope-eval-test@dryscope.iam.gserviceaccount.com"
    )])
    error_message = "The binding is workload identity user on the evaluation account, for the same scoped principal set."
  }
}
