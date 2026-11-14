output "sql_instance_name" {
  value = google_sql_database_instance.main.name
}

output "sql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "firestore_database_id" {
  value = google_firestore_database.field.name
}

output "evidence_bucket" {
  value = google_storage_bucket.evidence.name
}

output "artifact_repository" {
  value = google_artifact_registry_repository.images.repository_id
}

output "secret_ids" {
  description = "Secret names the owner must add a value to."
  value       = concat([for s in google_secret_manager_secret.app : s.secret_id], [for s in google_secret_manager_secret.synthetic_password : s.secret_id])
}

output "recaptcha_site_key" {
  description = "The web app's reCAPTCHA Enterprise site key for App Check (public: the browser sends it)."
  value       = google_recaptcha_enterprise_key.web.name
}

output "identity_users_role" {
  description = "Custom role the owner binds on each of this environment's sign-in tenants, never on the project."
  value       = "projects/${var.project_id}/roles/${google_project_iam_custom_role.identity_users.role_id}"
}

output "service_account_emails" {
  value = {
    for k, v in merge(google_service_account.runtime, { deploy = google_service_account.deploy }) : k => v.email
  }
}
