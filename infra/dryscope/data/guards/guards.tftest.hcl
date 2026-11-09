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

run "create_everything" {
  command = apply
}
