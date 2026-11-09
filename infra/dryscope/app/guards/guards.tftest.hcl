# Creates the whole root against the mock provider. Nothing here reaches Google Cloud.
#
# Terraform then tries to destroy everything it created when the file ends, and it
# refuses to destroy a resource that carries lifecycle.prevent_destroy. That refusal is the
# behaviour under test: scripts/check-guards.js reads the teardown errors and requires one
# for every protected resource, so a removed or falsified guard is noticed.
#
# This file is not part of the normal suite (it lives outside tests/ and its teardown is
# expected to fail). check.sh runs it with -test-directory=guards.

mock_provider "google" {}

variables {
  alert_email = "alerts@example.invalid"
}

run "create_everything" {
  command = apply
}

# A later release with a different image must not change what Terraform plans: releases go
# through gcloud, and Terraform ignores the image after the service exists. If the
# ignore_changes entry for the image is removed, this plan puts the new digest back and fails.
run "a_different_image_is_not_planned_after_create" {
  command = plan

  variables {
    api_image  = "us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-test/web@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    live_image = "us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-test/live@sha256:5555555555555555555555555555555555555555555555555555555555555555"
  }

  assert {
    condition     = google_cloud_run_v2_service.svc["api"].template[0].containers[0].image == "us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-test/web@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    error_message = "A new web image digest was planned: Terraform and the release path would fight over the image."
  }
  assert {
    condition     = google_cloud_run_v2_service.svc["live"].template[0].containers[0].image == "us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-test/live@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    error_message = "A new relay image digest was planned: Terraform and the release path would fight over the image."
  }
}
