terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.46"
    }
  }

  # Partial configuration: the bucket and prefix come from envs/backend-<env>.hcl
  # so test and live never share state. Checks run with `init -backend=false`.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region

  # The billing budget API bills quota to the project instead of the caller.
  user_project_override = true
  billing_project       = var.project_id
}
