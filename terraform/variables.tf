variable "project_prefix" {
  type        = string
  default     = "scribant"
  description = "Prefix for the GCP project name and project ID."
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Environment name (e.g. dev, staging, prod). Acts as a keeper for random_pet."
}

variable "org_id" {
  type        = string
  default     = "101096319108"
  description = "GCP Organization ID (optional, leave empty if creating project without org)."
}

variable "folder_id" {
  type        = string
  default     = ""
  description = "GCP Folder ID (optional, leave empty if attaching directly to org or root)."
}

variable "billing_account" {
  type        = string
  default     = "01C57A-D0DCD2-49BE8B"
  description = "GCP Billing Account ID to link to the new project."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Default GCP region."
}

variable "zone" {
  type        = string
  default     = "us-central1-a"
  description = "Default GCP zone."
}

variable "gcp_services" {
  type        = list(string)
  description = "List of GCP API services to enable for Vertex AI and Memory Bank."
  default = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "aiplatform.googleapis.com",
    "generativelanguage.googleapis.com",
    "discoveryengine.googleapis.com"
  ]
}
