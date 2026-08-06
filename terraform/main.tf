# Dynamic pet name generator with keepers.
# As long as the declared keeper keys (prefix & environment) remain constant,
# random_pet will NOT re-generate a new name across subsequent `terraform apply` runs.
# Only created when var.project_id is not set (i.e. we need to auto-generate an ID).
resource "random_pet" "project" {
  count     = var.project_id == "" ? 1 : 0
  length    = 2
  separator = "-"
  keepers = {
    prefix      = var.project_prefix
    environment = var.environment
  }
}

locals {
  # GCP project IDs must be 6 to 30 characters long, lowercase letters, numbers, or hyphens.
  raw_id       = "${var.project_prefix}-${var.environment}-${try(random_pet.project[0].id, "")}"
  generated_id = lower(substr(local.raw_id, 0, 30))

  # Use the explicit project_id variable when provided, otherwise fall back to the
  # generated pet-name scheme.
  project_id = var.project_id != "" ? var.project_id : local.generated_id

  # true when the project ID came from the variable rather than being generated here.
  using_provided_project_id = var.project_id != ""
}

# GCP Project Resource
#
# deletion_policy (a regular resource argument, not a lifecycle meta-argument) lets
# this be driven by a variable directly: "PREVENT" blocks any destroy of the project
# via `terraform apply`/`terraform destroy`; "DELETE" allows it, matching the prior
# behavior for auto-generated pet-name projects.
resource "google_project" "project" {
  name            = local.project_id
  project_id      = local.project_id
  org_id          = var.org_id != "" ? var.org_id : null
  folder_id       = var.folder_id != "" ? var.folder_id : null
  billing_account = var.billing_account != "" ? var.billing_account : null

  auto_create_network = false

  # Protected whenever the project ID came from var.project_id (e.g. an existing,
  # pre-provisioned project like "agentclinicep04"); freely destroyable otherwise.
  deletion_policy = local.using_provided_project_id ? "PREVENT" : "DELETE"
}

# Enable required GCP APIs for Vertex AI and Memory Bank
resource "google_project_service" "services" {
  for_each = toset(var.gcp_services)

  project = google_project.project.project_id
  service = each.value

  disable_on_destroy = false
}
