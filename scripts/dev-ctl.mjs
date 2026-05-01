#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// Load .env file and parse environment variables
function loadEnvFile(envPath) {
  const envVars = {};
  if (!fs.existsSync(envPath)) {
    console.warn(`Warning: ${envPath} not found`);
    return envVars;
  }
  
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    envVars[key] = value;
  }
  
  return envVars;
}

// Load .env from root directory
const envVars = loadEnvFile(path.join(root, ".env"));

const services = {
  api: {
    filter: "@workspace/api-server",
    script: "dev",
    env: { 
      PORT: "8080", 
      NODE_ENV: "development",
      // These will be loaded from .env if present, but can be overridden here
      DATABASE_URL: envVars.DATABASE_URL || "",
      JWT_SECRET: envVars.JWT_SECRET || "",
      ADMIN_JWT_SECRET: envVars.ADMIN_JWT_SECRET || "",
      ADMIN_REFRESH_SECRET: envVars.ADMIN_REFRESH_SECRET || "",
      VENDOR_JWT_SECRET: envVars.VENDOR_JWT_SECRET || "",
      RIDER_JWT_SECRET: envVars.RIDER_JWT_SECRET || "",
      SESSION_SECRET: envVars.SESSION_SECRET || "",
    },
    label: "API server",
  },
  admin: {
    filter: "@workspace/admin",
    script: "dev",
    env: { PORT: "5173", HOST: "0.0.0.0", BASE_PATH: "/admin/", VITE_API_PROXY_TARGET: "http://127.0.0.1:8080" },
    label: "Admin web",
  },
  vendor: {
    filter: "@workspace/vendor-app",
    script: "dev",
    env: { PORT: "5174", HOST: "0.0.0.0", BASE_PATH: "/vendor/", VITE_API_PROXY_TARGET: "http://127.0.0.1:8080" },
    label: "Vendor web",
  },
  rider: {
    filter: "@workspace/rider-app",
    script: "dev",
    env: { PORT: "5175", HOST: "0.0.0.0", BASE_PATH: "/rider/", VITE_API_PROXY_TARGET: "http://127.0.0.1:8080" },
    label: "Rider web",
  },
  ajkmart: {
    filter: "@workspace/ajkmart",
    script: "dev:web",
    env: {
      PORT: "19006",
      BASE_PATH: "/",
      EXPO_PUBLIC_DOMAIN: "127.0.0.1:8080",
      REPLIT_DEV_DOMAIN: "127.0.0.1:8080",
      REPLIT_EXPO_DEV_DOMAIN: "127.0.0.1:8080",
      REPL_ID: process.env.REPL_ID || "local",
    },
    label: "AJKMart Expo web",
  },
  sandbox: {
    filter: "@workspace/mockup-sandbox",
    script: "dev",
    env: { PORT: "8081", HOST: "0.0.0.0", BASE_PATH: "/__mockup" },
    label: "Mockup sandbox",
  },
};

const validActions = new Set(["start", "stop", "status", "help"]);
const args = process.argv.slice(2);
const action = args[0] || "help";
const target = args[1] || "all";

function usage() {
  console.log("Usage: pnpm run dev -- <start|stop|status> <all|api|admin|vendor|rider|ajkmart|sandbox>");
  console.log("Examples:");
  console.log("  pnpm run start:all");
  console.log("  pnpm run stop:api");
  console.log("  pnpm run start:admin");
  console.log("  pnpm run status all");
}

function getTargets(name) {
  if (name === "all") return Object.keys(services);
  if (services[name]) return [name];
  throw new Error(`Unknown target: ${name}`);
}

function spawnService(name) {
  const service = services[name];
  if (!service) throw new Error(`Unknown service ${name}`);
  
  // Merge: process.env → loaded .env → service.env (service.env has highest priority)
  const env = { ...process.env, ...envVars, ...service.env };
  
  // Validate critical environment variables for API service
  if (name === "api") {
    const criticalVars = ["DATABASE_URL", "JWT_SECRET"];
    const missing = criticalVars.filter(v => !env[v]);
    if (missing.length > 0) {
      console.error(`❌ ERROR: Missing critical environment variables: ${missing.join(", ")}`);
      console.error(`   Make sure .env file exists in ${root} with these variables set.`);
      throw new Error("Missing required environment variables for API server");
    }
    console.log(`✅ Environment variables loaded for API server`);
  }
  
  const args = ["--filter", service.filter, service.script];
  console.log(`Starting ${service.label} with: pnpm ${args.join(" ")}`);
  const child = spawn("pnpm", args, {
    cwd: root,
    env,
    stdio: "inherit",
    detached: true,
    shell: false,
  });
  child.on("error", (err) => {
    console.error(`Failed to start ${service.label}:`, err.message);
  });
  child.unref();
}

function stopService(name) {
  const service = services[name];
  if (!service) throw new Error(`Unknown service ${name}`);
  const pattern = `${service.filter} .* ${service.script}`;
  console.log(`Stopping ${service.label} by process match: ${pattern}`);
  const result = spawnSync("pkill", ["-f", pattern], { stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(`No matching running process found for ${service.label} or pkill returned ${result.status}`);
  }
}

function statusService(name) {
  const service = services[name];
  if (!service) throw new Error(`Unknown service ${name}`);
  const pattern = `${service.filter} .* ${service.script}`;
  const result = spawnSync("pgrep", ["-af", pattern], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    console.log(`${service.label}: not running`);
    return;
  }
  console.log(`${service.label}:`);
  console.log(result.stdout.trim());
}

try {
  if (!validActions.has(action)) {
    throw new Error(`Unknown action: ${action}`);
  }
  if (action === "help") {
    usage();
    process.exit(0);
  }

  const targets = getTargets(target);
  if (action === "start") {
    for (const name of targets) spawnService(name);
    process.exit(0);
  }
  if (action === "stop") {
    for (const name of targets) stopService(name);
    process.exit(0);
  }
  if (action === "status") {
    for (const name of targets) statusService(name);
    process.exit(0);
  }
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(1);
}
