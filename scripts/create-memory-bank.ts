#!/usr/bin/env npx tsx
import { createCloudMemoryBank, listCloudMemoryBanks } from "../memory";

async function main() {
  const command = process.argv[2] || "create";

  if (command === "list") {
    console.log("Listing Vertex AI Memory Banks in GCP project...");
    const list = await listCloudMemoryBanks();
    console.log("Memory Banks found:", JSON.stringify(list, null, 2));
    return;
  }

  console.log("Creating Vertex AI Memory Bank in GCP project...");
  const result = await createCloudMemoryBank({
    displayName: process.env.MEMORY_BANK_DISPLAY_NAME || "scribant-memory-bank",
    description: "Memory Bank for Scribant Voice Agent",
  });

  console.log("✓ Vertex AI Memory Bank successfully created on Google Cloud!");
  console.log(`  Project:         ${result.projectId}`);
  console.log(`  Location:        ${result.location}`);
  console.log(`  Display Name:    ${result.displayName}`);
  console.log(`  Agent Engine ID: ${result.agentEngineId}`);
  console.log(`  Resource Name:   ${result.resourceName}`);
  console.log("\nTo use this Memory Bank, ensure your .env has:");
  console.log(`VERTEX_AI_AGENT_ENGINE_ID=${result.agentEngineId}`);
  console.log(`VERTEX_AI_LOCATION=${result.location}`);
}

main().catch(err => {
  console.error("Failed to create Memory Bank:", err?.message || err);
  process.exit(1);
});
