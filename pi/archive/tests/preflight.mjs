#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const settingsPath = path.join(root, "settings.json");
const modelsPath = path.join(root, "models.json");
const liveSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
const liveModelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");

function fail(message) {
  console.error(`preflight: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    fail(`could not parse ${filePath}: ${error.message}`);
  }
}

function sameJsonFile(aPath, bPath) {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return false;
  try {
    const a = JSON.parse(fs.readFileSync(aPath, "utf-8"));
    const b = JSON.parse(fs.readFileSync(bPath, "utf-8"));
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function getModelIds(providerRecord) {
  const models = Array.isArray(providerRecord?.models) ? providerRecord.models : [];
  return new Set(
    models
      .map((model) => (typeof model?.id === "string" ? model.id.trim() : ""))
      .filter(Boolean)
  );
}

const settings = readJson(settingsPath);
const modelsDoc = readJson(modelsPath);

const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
const defaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
const enabledModels = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
const providers = modelsDoc?.providers && typeof modelsDoc.providers === "object" ? modelsDoc.providers : {};
const sidecar = modelsDoc?.sidecar && typeof modelsDoc.sidecar === "object" ? modelsDoc.sidecar : {};

if (!defaultProvider) fail("settings.json defaultProvider is missing");
if (!defaultModel) fail("settings.json defaultModel is missing");
if (!(defaultProvider in providers)) fail(`models.json is missing provider '${defaultProvider}'`);

const defaultProviderModelIds = getModelIds(providers[defaultProvider]);
if (!defaultProviderModelIds.has(defaultModel)) {
  fail(`default model '${defaultModel}' is not registered under provider '${defaultProvider}'`);
}

for (const enabledModel of enabledModels) {
  const hit = Object.values(providers).some((providerRecord) => getModelIds(providerRecord).has(enabledModel));
  if (!hit) fail(`enabled model '${enabledModel}' is not present in models.json`);
}

const sidecarConfig = sidecar[defaultProvider];
if (!sidecarConfig || typeof sidecarConfig !== "object") {
  fail(`sidecar config for provider '${defaultProvider}' is missing`);
}

const sidecarProvider =
  typeof sidecarConfig._sidecarProvider === "string" && sidecarConfig._sidecarProvider.trim()
    ? sidecarConfig._sidecarProvider.trim()
    : defaultProvider;

if (!(sidecarProvider in providers)) {
  fail(`sidecar provider '${sidecarProvider}' is not registered in models.json`);
}

const sidecarProviderModelIds = getModelIds(providers[sidecarProvider]);
for (const role of ["optimizer", "optimizerFallback", "researchOptimizer", "oracle", "rlmExtractor", "compaction", "verifier", "critic"]) {
  const value = typeof sidecarConfig[role] === "string" ? sidecarConfig[role].trim() : "";
  if (!value) continue;
  if (!sidecarProviderModelIds.has(value) && !defaultProviderModelIds.has(value)) {
    fail(`sidecar role '${role}' points to missing model '${value}'`);
  }
}

console.log(`preflight: ok`);
console.log(`provider=${defaultProvider}`);
console.log(`defaultModel=${defaultModel}`);
console.log(`sidecarProvider=${sidecarProvider}`);
if (!sameJsonFile(settingsPath, liveSettingsPath)) fail(`live settings drift: ${liveSettingsPath}`);
if (!sameJsonFile(modelsPath, liveModelsPath)) fail(`live models drift: ${liveModelsPath}`);
console.log(`next=run Pi and execute /doctor`);
