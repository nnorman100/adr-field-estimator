# Mocked checks for the app root. Nothing here reaches Google Cloud: the mock
# provider answers every call. Run once per environment:
#   terraform test -var-file=envs/test.tfvars -var-file=tests/images-test.tfvars
#   terraform test -var-file=envs/live.tfvars -var-file=tests/images-live.tfvars

mock_provider "google" {}

# Images come from tests/images-<env>.tfvars, so each environment is exercised
# with an image from its own repository (a test file's own variables would
# override the command line). Pass both files:
#   terraform test -var-file=envs/test.tfvars -var-file=tests/images-test.tfvars
variables {
  alert_email = "alerts@example.invalid"
}

run "services_are_central_protected_and_use_their_own_accounts" {
  command = plan

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.location == "us-central1"])
    error_message = "Both services must be in us-central1."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.deletion_protection == true])
    error_message = "Cloud Run deletion protection must be on."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : endswith(s.name, "-${var.environment}")])
    error_message = "Service names carry the environment."
  }
  assert {
    condition     = google_cloud_run_v2_service.svc["api"].template[0].service_account == "dryscope-api-${var.environment}@dryscope.iam.gserviceaccount.com"
    error_message = "The web app runs as its own environment's account."
  }
  assert {
    condition     = google_cloud_run_v2_service.svc["live"].template[0].service_account == "dryscope-live-${var.environment}@dryscope.iam.gserviceaccount.com"
    error_message = "The relay runs as its own environment's account."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : alltrue([for c in s.template[0].containers : can(regex("@sha256:", c.image))])])
    error_message = "Images must be pinned by digest."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.name != "alert-disaster-field-estimator"])
    error_message = "The legacy us-west2 service must not be managed here."
  }
}

run "relay_keeps_long_sockets_on_one_instance" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.svc["live"].template[0].timeout == "3600s"
    error_message = "The relay needs the 3600-second request timeout."
  }
  assert {
    condition     = google_cloud_run_v2_service.svc["live"].template[0].session_affinity == true
    error_message = "The relay needs session affinity."
  }
}

run "test_scales_to_zero_and_live_stays_warm" {
  command = plan

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.template[0].scaling[0].min_instance_count == 0]) || var.environment == "live"
    error_message = "Test services must scale to zero."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : s.template[0].scaling[0].min_instance_count >= 1]) || var.environment == "test"
    error_message = "Live services keep a warm instance."
  }
}

run "secrets_are_references_only" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for k, s in google_cloud_run_v2_service.svc : [
        for c in s.template[0].containers : [
          for e in c.env : (e.value == null || e.value == "") == (length(e.value_source) == 1)
        ]
      ]
    ]))
    error_message = "A secret variable has a reference and no literal value; a plain one has the reverse."
  }
  assert {
    condition = alltrue(flatten([
      for k, s in google_cloud_run_v2_service.svc : [
        for c in s.template[0].containers : [
          for e in c.env : startswith(e.value_source[0].secret_key_ref[0].secret, "dryscope-${var.environment}-") if length(e.value_source) == 1
        ]
      ]
    ]))
    error_message = "Secret references must name this environment's secrets."
  }
}

run "data_stays_inside_this_environment" {
  command = plan

  assert {
    condition     = contains(google_cloud_run_v2_service.svc["api"].template[0].volumes[0].cloud_sql_instance[0].instances, "dryscope:us-central1:dryscope-${var.environment}-pg")
    error_message = "The service connects to this environment's SQL instance."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.svc["api"].template[0].containers[0].env : e.value], "dryscope-field-${var.environment}")
    error_message = "The service names this environment's Firestore database explicitly."
  }
}

run "both_services_get_this_environments_sign_in_settings" {
  command = plan

  assert {
    condition = alltrue([
      for k, s in google_cloud_run_v2_service.svc : (
        { for e in s.template[0].containers[0].env : e.name => e.value if length(e.value_source) == 0 }["GOOGLE_CLOUD_PROJECT"] == "dryscope"
      )
    ])
    error_message = "Both services name project dryscope, which holds the sign-in tenants."
  }
  assert {
    condition = alltrue([
      for k, s in google_cloud_run_v2_service.svc : (
        { for e in s.template[0].containers[0].env : e.name => e.value if length(e.value_source) == 0 }["FIRESTORE_DATABASE_ID"] == "dryscope-field-${var.environment}"
      )
    ])
    error_message = "Both services name this environment's Firestore database."
  }
  assert {
    condition = alltrue([
      for k, s in google_cloud_run_v2_service.svc : (
        { for e in s.template[0].containers[0].env : e.name => e.value if length(e.value_source) == 0 }["ALLOWED_ORIGINS"] == "https://dryscope-api-${var.environment}-570228742694.us-central1.run.app"
      )
    ])
    error_message = "Both services accept browser requests and sockets only from this environment's web app address."
  }
}

run "deploy_role_cannot_delete_and_public_access_is_invocation_only" {
  command = plan

  assert {
    condition     = google_project_iam_custom_role.deploy.role_id == "dryscopeDeploy${title(var.environment)}"
    error_message = "Each environment has its own deploy role."
  }
  assert {
    condition     = alltrue([for p in google_project_iam_custom_role.deploy.permissions : startswith(p, "run.") && (endswith(p, ".get") || endswith(p, ".list") || p == "run.services.update")])
    error_message = "The deploy role only reads Cloud Run and updates services: no delete, create or IAM change."
  }
  assert {
    condition     = contains(google_project_iam_custom_role.deploy.permissions, "run.services.update")
    error_message = "The deploy role can deploy revisions and move traffic."
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.deploy) == 2 && alltrue([for k, b in google_cloud_run_v2_service_iam_member.deploy : b.role == "projects/dryscope/roles/dryscopeDeploy${title(var.environment)}" && b.member == "serviceAccount:dryscope-deploy-${var.environment}@dryscope.iam.gserviceaccount.com"])
    error_message = "Only this environment's deploy account gets the custom deploy role, on each service."
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 2 && alltrue([for k, b in google_cloud_run_v2_service_iam_member.public : b.role == "roles/run.invoker" && b.member == "allUsers"])
    error_message = "Public access is invocation of the two services only."
  }
}

run "alerts_exist_and_only_live_probes_health" {
  command = plan

  assert {
    condition     = length(google_monitoring_alert_policy.server_errors) == 2 && length(google_monitoring_alert_policy.sql) == 2
    error_message = "Server-error alerts for both services and two database alerts."
  }
  assert {
    condition     = alltrue([for k, p in google_monitoring_alert_policy.sql : strcontains(p.conditions[0].condition_threshold[0].filter, "resource.labels.database_id = \"dryscope:dryscope-${var.environment}-pg\"")])
    error_message = "Database alerts match Cloud SQL's project:instance monitoring identifier."
  }
  assert {
    condition     = (length(google_monitoring_uptime_check_config.api_health) == 1) == (var.environment == "live")
    error_message = "Only live probes health."
  }
}

run "budget_is_a_stub_until_a_billing_account_is_given" {
  command = plan

  assert {
    condition     = length(google_billing_budget.monthly) == 0
    error_message = "No budget without a billing account."
  }
}

run "budget_alerts_when_a_billing_account_is_given" {
  command = plan

  variables {
    billing_account_id = "000000-000000-000000"
  }

  assert {
    condition     = length(google_billing_budget.monthly) == 1
    error_message = "A billing account creates the budget alert."
  }
}

run "wrong_project_is_refused" {
  command = plan

  variables {
    project_id = "mitigation-project"
  }

  expect_failures = [var.project_id]
}

run "legacy_project_is_refused" {
  command = plan

  variables {
    project_id = "alert-disaster-field-2026"
  }

  expect_failures = [var.project_id]
}

run "legacy_region_is_refused" {
  command = plan

  variables {
    region = "us-west2"
  }

  expect_failures = [var.region]
}

run "tagged_image_is_refused" {
  command = plan

  variables {
    api_image = "us-central1-docker.pkg.dev/dryscope/dryscope-${var.environment}/web:latest"
  }

  expect_failures = [var.api_image]
}

run "image_from_another_project_is_refused" {
  command = plan

  variables {
    live_image = "us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-${var.environment}/live@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [var.live_image]
}

# The other environment's repository, in both directions: under test.tfvars this
# is the live repository, under live.tfvars it is the test one.
run "web_image_from_the_other_environments_repository_is_refused" {
  command = plan

  variables {
    api_image = "us-central1-docker.pkg.dev/dryscope/dryscope-${var.environment == "test" ? "live" : "test"}/web@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  }

  expect_failures = [var.api_image]
}

run "relay_image_from_the_other_environments_repository_is_refused" {
  command = plan

  variables {
    live_image = "us-central1-docker.pkg.dev/dryscope/dryscope-${var.environment == "test" ? "live" : "test"}/live@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  }

  expect_failures = [var.live_image]
}

# The app refuses to start without APP_ENV (web/src/lib/config.ts), so a revision built from any
# other name never becomes ready.
run "both_services_receive_the_environment_name_the_app_reads" {
  command = plan

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : contains([for e in s.template[0].containers[0].env : e.value if e.name == "APP_ENV"], var.environment)])
    error_message = "Each service must set APP_ENV to its environment."
  }
}

# The app logs in to Cloud SQL as its own account's IAM database user over the /cloudsql socket
# (web/src/db/client.ts); the user name must match the one the data root created.
run "each_service_names_its_own_iam_database_user" {
  command = plan

  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : contains([for e in s.template[0].containers[0].env : e.value if e.name == "SQL_IAM_USER"], "dryscope-${k}-${var.environment}@dryscope.iam")])
    error_message = "Each service must log in as its own dryscope-<service>-<env>@dryscope.iam database user."
  }
  assert {
    condition     = alltrue([for k, s in google_cloud_run_v2_service.svc : contains([for e in s.template[0].containers[0].env : e.value if e.name == "SQL_CONNECTION_NAME"], "dryscope:us-central1:dryscope-${var.environment}-pg")])
    error_message = "Each service must point at its own environment's instance."
  }
}

run "plain_http_origin_is_refused" {
  command = plan

  variables {
    allowed_origins = ["http://dryscope-api-${var.environment}-570228742694.us-central1.run.app"]
  }

  expect_failures = [var.allowed_origins]
}

run "wildcard_origin_is_refused" {
  command = plan

  variables {
    allowed_origins = ["https://*.run.app"]
  }

  expect_failures = [var.allowed_origins]
}

run "origin_with_a_path_or_trailing_slash_is_refused" {
  command = plan

  variables {
    allowed_origins = ["https://dryscope-api-${var.environment}-570228742694.us-central1.run.app/"]
  }

  expect_failures = [var.allowed_origins]
}

run "no_origin_is_refused" {
  command = plan

  variables {
    allowed_origins = []
  }

  expect_failures = [var.allowed_origins]
}

run "the_other_environments_web_app_origin_is_refused" {
  command = plan

  variables {
    allowed_origins = ["https://dryscope-api-${var.environment == "test" ? "live" : "test"}-570228742694.us-central1.run.app"]
  }

  expect_failures = [var.allowed_origins]
}

# The migration job (migrate_job.tf): the release runs numbered migrations here, inside Google,
# before traffic moves, so it never depends on the CI runner reaching Cloud SQL.
run "migration_job_runs_the_web_image_as_the_migrator_on_its_own_instance" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_job.migrate.name == "dryscope-migrate-${var.environment}" && google_cloud_run_v2_job.migrate.location == "us-central1"
    error_message = "The migration job carries the environment and lives in us-central1."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.deletion_protection == true
    error_message = "Cloud Run deletion protection must be on for the migration job."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].service_account == "dryscope-migrate-${var.environment}@dryscope.iam.gserviceaccount.com"
    error_message = "The migration job runs as this environment's migrator, never as the web app or the deploy account."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].image == var.api_image
    error_message = "The migration job starts from the web image the release ships."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].command == tolist(["node"]) && google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].args == tolist(["migrate.mjs"])
    error_message = "The migration job starts the bundled migrator (web/src/db/job.ts), not the web server."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].task_count == 1 && google_cloud_run_v2_job.migrate.template[0].template[0].max_retries == 0
    error_message = "One task, no retries: a failed migration fails the release instead of running again."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].volumes[0].cloud_sql_instance[0].instances == tolist(["dryscope:us-central1:dryscope-${var.environment}-pg"])
    error_message = "The migration job connects to this environment's instance only."
  }
  assert {
    condition = (
      { for e in google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].env : e.name => e.value } == {
        APP_ENV             = var.environment
        SQL_CONNECTION_NAME = "dryscope:us-central1:dryscope-${var.environment}-pg"
        SQL_DATABASE_NAME   = "dryscope"
        SQL_IAM_USER        = "dryscope-migrate-${var.environment}@dryscope.iam"
      }
    )
    error_message = "The migration job gets exactly its environment, instance, database and the migrator's IAM database user, and no secret."
  }
}

run "deploy_account_may_only_update_and_run_the_migration_job" {
  command = plan

  assert {
    condition     = google_project_iam_custom_role.migrate_job.role_id == "dryscopeMigrateJob${title(var.environment)}"
    error_message = "Each environment has its own migration job role."
  }
  assert {
    condition = toset(google_project_iam_custom_role.migrate_job.permissions) == toset([
      "run.executions.get",
      "run.executions.list",
      "run.jobs.get",
      "run.jobs.run",
      "run.jobs.update",
      "run.operations.get",
      "run.tasks.get",
      "run.tasks.list",
    ])
    error_message = "The migration job role sets the image, executes and reads executions: no create, delete, overrides, cancel or IAM change."
  }
  assert {
    condition     = google_cloud_run_v2_job_iam_member.deploy.name == "dryscope-migrate-${var.environment}" && google_cloud_run_v2_job_iam_member.deploy.member == "serviceAccount:dryscope-deploy-${var.environment}@dryscope.iam.gserviceaccount.com" && google_cloud_run_v2_job_iam_member.deploy.role == "projects/dryscope/roles/dryscopeMigrateJob${title(var.environment)}"
    error_message = "Only this environment's deploy account gets the migration job role, on the job only."
  }
}
