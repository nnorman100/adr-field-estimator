# Creates the whole root against the mock provider. Nothing here reaches Google Cloud.
#
# Terraform then tries to destroy everything it created when the file ends, and, on versions
# that report it (1.12), refuses to destroy a resource that carries lifecycle.prevent_destroy.
# scripts/check-guards.js requires this run to pass and, if the teardown prints any refusal,
# requires one for every protected resource. Terraform 1.17 prints none, so the check also
# reads lifecycle.prevent_destroy from the .tf files, which is what catches a removed or
# falsified guard on every version.
#
# This file is not part of the normal suite (it lives outside tests/ and its teardown is
# expected to fail). check.sh runs it with -test-directory=guards.

mock_provider "google" {}

run "create_everything" {
  command = apply
}
