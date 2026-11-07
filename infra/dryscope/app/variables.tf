variable "project_id" {
  type        = string
  description = "The dedicated DryScope project. No other project is accepted."

  validation {
    condition     = var.project_id == "alert-disaster-field-2026"
    error_message = "This root only manages project alert-disaster-field-2026."
  }
}

variable "region" {
  type        = string
  description = "Central region for every new resource. Existing legacy resources are never touched."

  validation {
    condition     = var.region == "us-central1"
    error_message = "New DryScope resources live in us-central1 only."
  }
}

variable "environment" {
  type        = string
  description = "test or live."

  validation {
    condition     = contains(["test", "live"], var.environment)
    error_message = "environment must be test or live."
  }
}

variable "api_image" {
  type        = string
  description = "Next.js app image, pinned by digest. Supplied by the release controller, never a tag."

  validation {
    condition     = can(regex("^us-central1-docker\\.pkg\\.dev/alert-disaster-field-2026/dryscope-(test|live)/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be a digest-pinned image in this project's us-central1 dryscope repository."
  }
}

variable "live_image" {
  type        = string
  description = "Node Live relay image, pinned by digest."

  validation {
    condition     = can(regex("^us-central1-docker\\.pkg\\.dev/alert-disaster-field-2026/dryscope-(test|live)/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.live_image))
    error_message = "live_image must be a digest-pinned image in this project's us-central1 dryscope repository."
  }
}

variable "api_scaling" {
  type = object({
    min_instances = number
    max_instances = number
    cpu           = string
    memory        = string
    concurrency   = number
    timeout_s     = number
  })
  description = "Cloud Run scaling and size for the Next.js app."
}

variable "live_scaling" {
  type = object({
    min_instances = number
    max_instances = number
    cpu           = string
    memory        = string
    concurrency   = number
    timeout_s     = number
  })
  description = "Cloud Run scaling and size for the Live relay. Sockets need a long request timeout."

  validation {
    condition     = var.live_scaling.timeout_s <= 3600
    error_message = "Cloud Run caps the request timeout at 3600 seconds."
  }
}

variable "public_invoker" {
  type        = bool
  description = "Allow unauthenticated HTTP invocation. The app verifies Firebase sign-in itself; Cloud Run IAM cannot front a browser app. Owner reviews this binding."
  default     = true
}

variable "ingress" {
  type        = string
  description = "Cloud Run ingress. Tightening it waits on the owner's front-door decision (load balancer and Cloud Armor)."
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.ingress)
    error_message = "ingress must be INGRESS_TRAFFIC_ALL or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER."
  }
}

variable "uptime_check_enabled" {
  type        = bool
  description = "Probe /api/health every five minutes. Off in test so scale-to-zero stays at zero."
}

variable "latency_p95_ms" {
  type        = number
  description = "p95 request latency that alerts for the web app."
  default     = 5000
}

variable "alert_email" {
  type        = string
  description = "Alert recipient. Passed at apply time (TF_VAR_alert_email); an address is never kept in git."
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must look like an email address."
  }
}

variable "billing_account_id" {
  type        = string
  description = "Billing account for the budget alert stub. Empty creates no budget."
  default     = ""
}

variable "budget_usd" {
  type        = number
  description = "Monthly budget for the alert stub, in US dollars."
  default     = 300
}
