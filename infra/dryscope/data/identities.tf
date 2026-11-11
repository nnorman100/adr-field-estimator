# Runtime accounts: one per service per environment, so a test service can never
# reach live data. Grants are scoped to this environment's own resources.
resource "google_service_account" "runtime" {
  for_each = {
    api     = "DryScope ${var.environment} web and API runtime"
    live    = "DryScope ${var.environment} Live relay runtime"
    migrate = "DryScope ${var.environment} schema migrator"
  }

  project      = var.project_id
  account_id   = local.n.service_account_ids[each.key]
  display_name = each.value

  depends_on = [google_project_service.apis]
}

# Deploy account: updates this environment's Cloud Run services and pushes its
# images. It holds no data access.
resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = local.n.service_account_ids["deploy"]
  display_name = "DryScope ${var.environment} deploy"

  depends_on = [google_project_service.apis]
}

# Scheduler account: Cloud Scheduler mints its ID token to call the web app's internal job routes
# (app root, scheduler.tf). It holds no role at all: the web app takes unauthenticated calls
# (cloud_run.tf) and its serviceRoute accepts only this account's Google-signed token with the
# job's own audience. The Cloud Scheduler service agent mints the token through its automatic
# roles/cloudscheduler.serviceAgent grant; whoever applies the app root needs actAs on it.
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = local.n.service_account_ids["scheduler"]
  display_name = "DryScope ${var.environment} scheduled jobs caller"

  depends_on = [google_project_service.apis]
}

# Connect to this environment's SQL instance and nothing else. Only the web app
# and the migrator: the Live relay gets no SQL access until a named table needs a
# narrower role.
resource "google_project_iam_member" "sql_client" {
  for_each = toset(["api", "migrate"])

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  condition {
    title       = "dryscope-${var.environment}-sql-only"
    description = "Only the ${var.environment} DryScope instance."
    expression  = local.sql_condition
  }

  depends_on = [google_service_account.runtime]
}

resource "google_project_iam_member" "sql_login" {
  for_each = toset(["api", "migrate"])

  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  condition {
    title       = "dryscope-${var.environment}-sql-login-only"
    description = "IAM database login on the ${var.environment} DryScope instance only."
    expression  = local.sql_condition
  }

  depends_on = [google_service_account.runtime]
}

# Read and write this environment's named Firestore database only, for the web
# app. roles/datastore.user includes delete, so the Live relay gets no Firestore
# access until a named need; the migrator does not touch Firestore.
resource "google_project_iam_member" "firestore_user" {
  for_each = toset(["api"])

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  condition {
    title       = "dryscope-${var.environment}-firestore-only"
    description = "The dryscope-field-${var.environment} database and its documents only."
    expression  = local.fs_condition
  }

  depends_on = [google_service_account.runtime]
}

# Gemini calls need one permission. roles/aiplatform.user also holds
# aiplatform.customJobs.create, which runs code as the project's Vertex AI
# service agent (storage read, write and delete) and is therefore a path from a
# test service to live data. This role is predict-only; add a permission only
# after naming the real operation that needs it. Vertex AI cannot be scoped to
# one environment, so the role is project-level and the owner reviews it.
resource "google_project_iam_custom_role" "gemini_caller" {
  project     = var.project_id
  role_id     = "dryscopeGemini${title(var.environment)}"
  title       = "DryScope ${var.environment} Gemini caller"
  description = "Call Gemini models for DryScope ${var.environment}. No jobs, no tuning, no deletes."
  permissions = ["aiplatform.endpoints.predict"]
}

resource "google_project_iam_member" "gemini_caller" {
  for_each = toset(["api", "live"])

  project = var.project_id
  role    = "projects/${var.project_id}/roles/${google_project_iam_custom_role.gemini_caller.role_id}"
  member  = "serviceAccount:${local.n.service_account_emails[each.key]}"

  depends_on = [google_service_account.runtime]
}

# Sign-in user management for the web app: read, create and update a user and send
# its sign-in emails. No users.delete, no configs.* (project and tenant settings are
# shared by test and live and stay owner-run) and no identitytoolkit.tenants.*.
# Nothing binds this role here, on purpose: a project-level binding would reach
# every tenant, including live's. The owner binds it on each of this environment's
# own sign-in tenants (tenants:setIamPolicy), never on the project (docs/runbook/terraform-apply.md).
resource "google_project_iam_custom_role" "identity_users" {
  project     = var.project_id
  role_id     = "dryscopeIdentity${title(var.environment)}"
  title       = "DryScope ${var.environment} sign-in users"
  description = "Read, create and update DryScope ${var.environment} sign-in users and send their emails. Bound per tenant only. No delete, no settings, no tenants."
  permissions = [
    "firebaseauth.users.create",
    "firebaseauth.users.get",
    "firebaseauth.users.sendEmail",
    "firebaseauth.users.update",
  ]
}

# The deploy account may act as the two services' runtime accounts and the migrator, no others.
# Cloud Run checks this on every update: the release sets the new image on the services and on the
# migration job (app root, migrate_job.tf), which runs as the migrator. The deploy account still
# holds no database role itself; it reaches the database only through that job.
resource "google_service_account_iam_member" "deploy_acts_as" {
  for_each = toset(["api", "live", "migrate"])

  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.n.service_account_emails[each.key]}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.n.service_account_emails["deploy"]}"

  depends_on = [google_service_account.runtime, google_service_account.deploy]
}

# Keyless GitHub Actions: only after the owner creates the pool and passes its
# principalSet. Nothing is bound until then.
resource "google_service_account_iam_member" "deploy_workload_identity" {
  count = var.workload_identity_principal_set == "" ? 0 : 1

  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.n.service_account_emails["deploy"]}"
  role               = "roles/iam.workloadIdentityUser"
  member             = var.workload_identity_principal_set

  depends_on = [google_service_account.deploy]
}

# The release workflow runs numbered migrations as the migrator before a new revision takes
# traffic. It signs in as the migrator directly, through the same repository-scoped principal set,
# so the deploy account keeps no route to the database. Cloud SQL IAM login needs a service
# account, which is why the principal set itself is never made a database user.
resource "google_service_account_iam_member" "migrate_workload_identity" {
  count = var.workload_identity_principal_set == "" ? 0 : 1

  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.n.service_account_emails["migrate"]}"
  role               = "roles/iam.workloadIdentityUser"
  member             = var.workload_identity_principal_set

  depends_on = [google_service_account.runtime]
}

# The release workflow releases web/firestore.rules to this environment's field database: create a
# ruleset from the file, then point release cloud.firestore/dryscope-field-<env> at it
# (.github/workflows/web-release.yml, web/scripts/release-rules.ts). It reads the current release
# and its ruleset first, so an unchanged file creates nothing. No delete, list, test or
# getExecutable. Firebase Rules supports no IAM condition on a release or ruleset name and its
# releases hold no IAM policy of their own, so this grant is project-wide: the deploy account can
# also point the other environment's release at a ruleset. The workflow names only its own
# database; the owner reviews this role at apply time (README, "Accepted risks").
resource "google_project_iam_custom_role" "rules_release" {
  project     = var.project_id
  role_id     = "dryscopeRulesRelease${title(var.environment)}"
  title       = "DryScope ${var.environment} field rules release"
  description = "Create a Firestore rules ruleset and point the dryscope-field-${var.environment} release at it. No delete."
  permissions = [
    "firebaserules.releases.create",
    "firebaserules.releases.get",
    "firebaserules.releases.update",
    "firebaserules.rulesets.create",
    "firebaserules.rulesets.get",
  ]
}

resource "google_project_iam_member" "deploy_rules_release" {
  project = var.project_id
  role    = "projects/${var.project_id}/roles/${google_project_iam_custom_role.rules_release.role_id}"
  member  = "serviceAccount:${local.n.service_account_emails["deploy"]}"

  depends_on = [google_service_account.deploy]
}
