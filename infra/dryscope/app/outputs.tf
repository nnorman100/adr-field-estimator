output "service_urls" {
  value = { for k, s in google_cloud_run_v2_service.svc : k => s.uri }
}

output "service_names" {
  value = { for k, s in google_cloud_run_v2_service.svc : k => s.name }
}

output "image_repository" {
  description = "Where the release controller pushes images for this environment."
  value       = local.image_repo
}
