#!/usr/bin/env npx tsx
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { createCloudMemoryBank, listCloudMemoryBanks } from "../memory";

function getCliArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function runCmd(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

async function discoverProjectId(): Promise<string> {
  // 1. Explicit CLI argument
  const fromCli = getCliArg("--project") || getCliArg("-p");
  if (fromCli) return fromCli;

  // 2. Environment variable
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.PROJECT_ID) return process.env.PROJECT_ID;

  // 3. Terraform output
  const fromTf = runCmd("terraform -chdir=terraform output -raw project_id 2>/dev/null");
  if (fromTf && !fromTf.includes("No outputs") && !fromTf.includes("Warning")) return fromTf;

  // 4. gcloud active project
  const fromGcloud = runCmd("gcloud config get-value project 2>/dev/null");
  if (fromGcloud && fromGcloud !== "(unset)") return fromGcloud;

  throw new Error(
    "Could not automatically detect a GCP project ID. Please provide one with --project <PROJECT_ID> or set GOOGLE_CLOUD_PROJECT."
  );
}

function discoverLocation(): string {
  return (
    getCliArg("--location") ||
    getCliArg("-l") ||
    process.env.VERTEX_AI_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    "us-central1"
  );
}

function discoverModel(): string {
  return (
    getCliArg("--model") ||
    getCliArg("-m") ||
    process.env.GEMINI_MODEL ||
    process.env.MODEL ||
    "gemini-3.7-flash"
  );
}

async function main() {
  console.log("==================================================================");
  console.log(" Scribant Agent: Portable GCP Environment Setup & Memory Bank    ");
  console.log("==================================================================");

  const projectId = await discoverProjectId();
  const location = discoverLocation();
  const model = discoverModel();
  const forceNew = process.argv.includes("--force-new");

  console.log(`\n• Target GCP Project:  ${projectId}`);
  console.log(`• Vertex AI Region:    ${location}`);
  console.log(`• Default Model:       ${model}`);

  // Step 1: Check existing Vertex AI Memory Banks in this project
  console.log("\n[1/3] Checking Vertex AI Memory Banks in project...");
  let agentEngineId: string | null = null;

  if (!forceNew) {
    try {
      const existingBanks = await listCloudMemoryBanks({ projectId, location });
      if (existingBanks.length > 0) {
        // Find most recent or matching
        const bank = existingBanks[0];
        const match = (bank.name || "").match(/reasoningEngines\/([^/]+)/);
        agentEngineId = match ? match[1] : bank.name.split("/").pop() || null;
        console.log(`  ✓ Found existing Memory Bank: ${bank.displayName || "scribant-memory-bank"}`);
        console.log(`    Agent Engine ID: ${agentEngineId}`);
        console.log(`    Resource Name:   ${bank.name}`);
      }
    } catch (err: any) {
      console.warn(`  ! Could not list existing Memory Banks: ${err?.message || err}`);
    }
  }

  // Step 2: Create new Memory Bank if none found or forced
  if (!agentEngineId) {
    console.log("  Creating new Vertex AI Memory Bank in GCP project...");
    const created = await createCloudMemoryBank({
      projectId,
      location,
      displayName: process.env.MEMORY_BANK_DISPLAY_NAME || "scribant-memory-bank",
      description: "Memory Bank for Scribant Voice Agent",
    });
    agentEngineId = created.agentEngineId;
    console.log(`  ✓ Successfully created Vertex AI Memory Bank!`);
    console.log(`    Agent Engine ID: ${agentEngineId}`);
    console.log(`    Resource Name:   ${created.resourceName}`);
  }

  // Step 3: Sync or generate .env file
  console.log("\n[2/3] Writing localized .env configuration...");
  const envPath = path.join(process.cwd(), ".env");

  // Read existing .env to preserve any custom keys if present
  let existingEnv = "";
  try {
    existingEnv = await fs.readFile(envPath, "utf-8");
  } catch {}

  // In Vertex AI mode, keep GEMINI_API_KEY commented out so SDK doesn't emit redundant warnings
  const geminiKeyMatch = existingEnv.match(/(?:#\s*)?(GEMINI_API_KEY\w*=.*)/);
  const preservedKey = geminiKeyMatch ? `# Preserved API Key (uncomment to switch from Vertex AI to Developer API keys)\n# ${geminiKeyMatch[1].replace(/^#\s*/, "")}\n` : "";

  const newEnvContent = `# Scribant Agent Local Environment Configuration
# Automatically generated/updated by scripts/setup-env.ts

GOOGLE_GENAI_USE_ENTERPRISE=TRUE
GOOGLE_CLOUD_PROJECT=${projectId}
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=${model}
VERTEX_AI_AGENT_ENGINE_ID=${agentEngineId}
VERTEX_AI_LOCATION=${location}

${preservedKey}`.trim() + "\n";

  await fs.writeFile(envPath, newEnvContent, "utf-8");
  console.log(`  ✓ Updated ${envPath}`);

  // Step 4: Verify OAuth credentials.json
  console.log("\n[3/3] Checking OAuth client configuration (credentials.json)...");
  const credsPath = path.join(process.cwd(), "credentials.json");
  let hasCreds = false;
  try {
    const credsData = JSON.parse(await fs.readFile(credsPath, "utf-8"));
    const clientId = (credsData.web ?? credsData.installed)?.client_id;
    if (clientId) {
      hasCreds = true;
      console.log(`  ✓ Found active OAuth Client ID: ${clientId}`);
    }
  } catch {}

  if (!hasCreds) {
    // Attempt to extract from Terraform outputs
    try {
      const tfJson = runCmd("terraform -chdir=terraform output -json 2>/dev/null");
      if (tfJson) {
        const parsed = JSON.parse(tfJson);
        const tfClientId = parsed.oauth_client_id?.value;
        const tfSecret = parsed.oauth_client_secret?.value;
        if (tfClientId) {
          const credsObj = {
            web: {
              client_id: tfClientId,
              project_id: projectId,
              auth_uri: "https://accounts.google.com/o/oauth2/auth",
              token_uri: "https://oauth2.googleapis.com/token",
              auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
              client_secret: tfSecret || "",
              redirect_uris: ["http://localhost:3000", "http://127.0.0.1:3000"],
              javascript_origins: ["http://localhost:3000", "http://127.0.0.1:3000"],
            },
          };
          await fs.writeFile(credsPath, JSON.stringify(credsObj, null, 2), { mode: 0o600 });
          console.log(`  ✓ Generated credentials.json from Terraform outputs (Client ID: ${tfClientId})`);
          hasCreds = true;
        }
      }
    } catch {}
  }

  if (!hasCreds) {
    console.log("  ℹ No OAuth credentials.json found. Run `make tf-apply` if you wish to generate internal IAP OAuth credentials for Google Workspace tools.");
  }

  console.log("\n==================================================================");
  console.log(" Setup Complete! You can now run:");
  console.log("   npm run dev       (or 'make dev')");
  console.log("==================================================================");
}

main().catch(err => {
  console.error("\n❌ Environment setup failed:", err?.message || err);
  process.exit(1);
});
