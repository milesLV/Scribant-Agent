# Dynamic pet name generator with keepers.
# As long as the declared keeper keys (prefix & environment) remain constant,
# random_pet will NOT re-generate a new name across subsequent `terraform apply` runs.
resource "random_pet" "project" {
  length    = 2
  separator = "-"
  keepers = {
    prefix      = var.project_prefix
    environment = var.environment
  }
}

locals {
  # GCP project IDs must be 6 to 30 characters long, lowercase letters, numbers, or hyphens.
  raw_id     = "${var.project_prefix}-${var.environment}-${random_pet.project.id}"
  project_id = lower(substr(local.raw_id, 0, 30))
}

# GCP Project Resource
resource "google_project" "project" {
  name            = local.project_id
  project_id      = local.project_id
  org_id          = var.org_id != "" ? var.org_id : null
  folder_id       = var.folder_id != "" ? var.folder_id : null
  billing_account = var.billing_account != "" ? var.billing_account : null

  auto_create_network = false
}

# Enable required GCP APIs for Vertex AI and Memory Bank
resource "google_project_service" "services" {
  for_each = toset(var.gcp_services)

  project = google_project.project.project_id
  service = each.value

  disable_on_destroy = false
}
