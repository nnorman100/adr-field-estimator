# App Check for the web app in monitoring mode (docs/plans/TC.md, TC-5 and TC-9).

locals {
  # The environment's own web app host, the deterministic run.app address (naming module api_url).
  # A key's allowed domains also admit every subdomain of each entry.
  app_host = trimprefix(local.n.api_url, "https://")
}

# The reCAPTCHA Enterprise key App Check uses on the web: a website key that only scores (SCORE never
# shows a checkbox or a challenge), allowed on this environment's app host and nothing else: no
# localhost, no wildcard, no "allow every domain", no AMP, no testing options
# (documents/docs.cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys; App Check needs a
# score-based website key with the checkbox off:
# documents/firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider). A local
# developer uses an App Check debug token instead. The site key is public: the browser sends it.
resource "google_recaptcha_enterprise_key" "web" {
  project      = var.project_id
  display_name = "DryScope ${var.environment} web app"
  labels       = local.labels

  # Losing the key turns App Check off for every phone until a new key is released in the app, so
  # the provider refuses to delete it, as does prevent_destroy below.
  deletion_policy = "PREVENT"

  web_settings {
    integration_type  = "SCORE"
    allow_all_domains = false
    allow_amp_traffic = false
    allowed_domains   = [local.app_host]
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.apis]
}

# Registers the web app with App Check through that key. Registering enforces nothing: App Check
# blocks nothing until a product is enforced in the Firebase console, which stays off until TC-13
# (C7 A). Tokens live one hour, Google's default (30 minutes to 7 days allowed:
# documents/firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.recaptchaEnterpriseConfig).
# Left out until the owner registers this environment's web app (owner step 8) and passes its id, so
# everything else can apply first. Each environment passes its own web app: two roots naming the same
# app would overwrite each other's registration.
resource "google_firebase_app_check_recaptcha_enterprise_config" "web" {
  count = var.app_check_web_app_id == "" ? 0 : 1

  project   = var.project_id
  app_id    = var.app_check_web_app_id
  site_key  = google_recaptcha_enterprise_key.web.name
  token_ttl = "3600s"

  depends_on = [google_project_service.apis]
}
