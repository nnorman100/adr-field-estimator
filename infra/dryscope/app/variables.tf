variable "project_id" {
  type        = string
  description = "The dedicated DryScope project. No other project is accepted."

  validation {
    condition     = var.project_id == "dryscope"
    error_message = "This root only manages project dryscope."
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
  description = "Next.js app image, pinned by digest, from this environment's own repository (dryscope-<environment>). Used when the service is first created; later releases go through gcloud and Terraform ignores the image."

  validation {
    condition     = can(regex("^us-central1-docker\\.pkg\\.dev/dryscope/dryscope-${var.environment}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be a digest-pinned image in this environment's own us-central1 repository, dryscope/dryscope-<environment>."
  }
}

variable "live_image" {
  type        = string
  description = "Node Live relay image, pinned by digest, from this environment's own repository. Used when the service is first created; later releases go through gcloud and Terraform ignores the image."

  validation {
    condition     = can(regex("^us-central1-docker\\.pkg\\.dev/dryscope/dryscope-${var.environment}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.live_image))
    error_message = "live_image must be a digest-pinned image in this environment's own us-central1 repository, dryscope/dryscope-<environment>."
  }
}

variable "allowed_origins" {
  type        = list(string)
  description = "Browser origins (https://host, no path, port or wildcard) the web app and the Live relay accept requests and sockets from: this environment's own web app address. Passed to both services as ALLOWED_ORIGINS, comma-separated."

  validation {
    condition = length(var.allowed_origins) > 0 && alltrue([
      for o in var.allowed_origins :
      can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", o))
    ])
    error_message = "allowed_origins needs at least one origin, each https://host in lower case with no path, port, trailing slash or wildcard."
  }

  validation {
    condition = alltrue([
      for o in var.allowed_origins :
      !can(regex("dryscope-(api|live)-${var.environment == "test" ? "live" : "test"}-", o))
    ])
    error_message = "allowed_origins must not name the other environment's services."
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

# App Check in monitor mode (docs/plans/TC.md, TC-5). Public values the browser receives: the web
# app id from owner step 8 and the reCAPTCHA Enterprise key id the data root creates (TC-9). Both
# empty by default, which leaves them out of the services' settings: App Check then stays off in the
# browser. Set both (TF_VAR_* at apply, TC-11) to turn it on.
variable "firebase_app_id" {
  type        = string
  description = "This environment's Firebase web app id (1:<project number>:web:<hex>), or empty while App Check is off."
  default     = ""

  validation {
    condition     = var.firebase_app_id == "" || can(regex("^[0-9]{1,3}:[0-9]{1,20}:web:[0-9a-f]{1,64}$", var.firebase_app_id))
    error_message = "Pass the web app id Firebase shows for this project's registered web app, or leave it empty."
  }
}

variable "app_check_site_key" {
  type        = string
  description = "The reCAPTCHA Enterprise site key App Check is registered with (the data root's key id), or empty while App Check is off."
  default     = ""

  validation {
    condition     = var.app_check_site_key == "" || can(regex("^[A-Za-z0-9_-]{20,100}$", var.app_check_site_key))
    error_message = "Pass the reCAPTCHA Enterprise key id, or leave it empty."
  }
}
