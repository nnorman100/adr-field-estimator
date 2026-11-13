# AI screening and access (docs/plans/S7.md, step S7-2): the Model Armor text template, the
# project's Model Armor floor setting, Model Armor sanitize access for the two services, and the
# test-only evaluation account (V9 B).
#
# Model Armor's own logging stays off everywhere: a template's log_sanitize_operations writes full
# prompts and responses to Cloud Logging, and the floor setting's Agent Platform logging does the
# same (and is on by default when the floor setting is saved in the console)
# (documents/docs.cloud.google.com/model-armor/configure-logging). Hard rule 6 keeps transcripts out
# of logs, so both are false here and scripts/check-plan.js refuses any plan that sets them.

locals {
  # The filters every DryScope screen uses: the template here, the floor setting below and the
  # owner-made image template (README, "Owner steps for AI"). Responsible AI filters, prompt
  # injection and jailbreak at medium and above, malicious URLs and basic Sensitive Data Protection.
  model_armor_rai_filters = ["DANGEROUS", "HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT"]
  model_armor_confidence  = "MEDIUM_AND_ABOVE"

  # Pinned so detection logic never changes under a running feature: v3 is the Stable version in
  # us-central1 (v4 is Latest, which Google recommends for evaluating, not production)
  # (documents/docs.cloud.google.com/model-armor/set-filter-version). A bump is a reviewed pull request
  # that re-runs the injection evaluation (docs/plans/S7.md section 3).
  model_armor_filter_version = "v3"
}

# Screens AI input and output text for the web app and the Live relay (explicit sanitize calls that
# fail closed, web/src/lib/ai/armor.ts). In us-central1, beside the data; that region has every
# filter used here (documents/docs.cloud.google.com/model-armor/feature-availability-by-region).
resource "google_model_armor_template" "text" {
  project     = var.project_id
  location    = var.region
  template_id = "dryscope-text-${var.environment}"
  labels      = local.labels

  # Terraform refuses to delete it twice over: the provider's own PREVENT and prevent_destroy below.
  # Without the template every AI call refuses (screening fails closed), so a delete is an outage.
  deletion_policy = "PREVENT"

  filter_config {
    rai_settings {
      dynamic "rai_filters" {
        for_each = local.model_armor_rai_filters
        content {
          filter_type      = rai_filters.value
          confidence_level = local.model_armor_confidence
        }
      }
    }
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = local.model_armor_confidence
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
  }

  template_metadata {
    enforcement_type        = "INSPECT_AND_BLOCK"
    log_sanitize_operations = false
    log_template_operations = false
    filter_version_selector {
      version = local.model_armor_filter_version
    }
    multi_language_detection {
      enable_multi_language_detection = true
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# The project's floor: Agent Platform generateContent calls are screened and blocked with the same
# filters even when a call names no template. It is the fail-open baseline, not the control: the
# integration skips screening when Model Armor is unavailable and covers non-streaming text only
# (documents/docs.cloud.google.com/model-armor/model-armor-vertex-integration), which is why the
# app also calls sanitize itself. Floor enforcement also makes every template in the project meet
# these filters (documents/docs.cloud.google.com/model-armor/configure-floor-settings).
#
# One floor setting serves the whole project, and test and live share project dryscope with
# separate states, so exactly one root may own it: the test root, applied first. The live root
# never manages it (two states would overwrite each other); it moves with live's own project (S8).
resource "google_model_armor_floorsetting" "project" {
  count = var.environment == "test" ? 1 : 0

  parent   = "projects/${var.project_id}"
  location = "global"

  enable_floor_setting_enforcement = true
  integrated_services              = ["AI_PLATFORM"]

  ai_platform_floor_setting {
    inspect_and_block    = true
    enable_cloud_logging = false
  }

  filter_config {
    rai_settings {
      dynamic "rai_filters" {
        for_each = local.model_armor_rai_filters
        content {
          filter_type      = rai_filters.value
          confidence_level = local.model_armor_confidence
        }
      }
    }
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = local.model_armor_confidence
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
  }

  floor_setting_metadata {
    multi_language_detection {
      enable_multi_language_detection = true
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# Sanitize calls against a template (unary and streaming), nothing else: no template create,
# update, delete or list, and no floor-setting access (documents/docs.cloud.google.com/iam/docs/
# roles-permissions/modelarmor). Model Armor is not among the services IAM Conditions can scope by
# resource name (documents/docs.cloud.google.com/iam/docs/conditions-resource-attributes), so the
# grant is project-wide and carries no condition: a test service could screen text against the live
# template, which only reads it (README, "Accepted risks").
resource "google_project_iam_member" "modelarmor_user" {
  for_each = toset(["api", "live"])

  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  depends_on = [google_service_account.runtime]
}

# The evaluation account (V9 B): the manual AI evaluation workflow (.github/workflows/ai-evals.yml,
# step S7-5) signs in as it to run real models on test. Predict and sanitize only, through the same
# predict-only role the services hold. Test only: live never runs evaluations.
resource "google_service_account" "eval" {
  count = var.environment == "test" ? 1 : 0

  project      = var.project_id
  account_id   = local.n.service_account_ids["eval"]
  display_name = "DryScope ${var.environment} AI evaluations"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "eval" {
  for_each = var.environment == "test" ? {
    predict    = "projects/${var.project_id}/roles/${google_project_iam_custom_role.gemini_caller.role_id}"
    modelarmor = "roles/modelarmor.user"
  } : {}

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${local.n.service_account_emails["eval"]}"

  depends_on = [google_service_account.eval]
}

# Keyless sign-in for the evaluation workflow: the same repository-scoped principal set from test's
# own pool that releases use (its provider admits only this repository's master branch in the test
# GitHub environment, docs/runbook/test-release.md). Nothing is bound until the owner supplies it.
resource "google_service_account_iam_member" "eval_workload_identity" {
  count = var.environment == "test" && var.workload_identity_principal_set != "" ? 1 : 0

  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.n.service_account_emails["eval"]}"
  role               = "roles/iam.workloadIdentityUser"
  member             = var.workload_identity_principal_set

  depends_on = [google_service_account.eval]
}
