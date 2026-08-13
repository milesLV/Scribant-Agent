terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.4"
    }
  }
}

# The google provider automatically utilizes Application Default Credentials (ADC).
# Run `gcloud auth application-default login` if local credentials need refreshing.
provider "google" {
  region = var.region
  zone   = var.zone
}
