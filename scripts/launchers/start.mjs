#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..", "..");

const SUPPORTED = new Set(["replit", "codespace", "vps", "local"]);
const argv = process.argv.slice(2);
const profile = argv.find(a => SUPPORTED.has(a));
const flags = new Set(argv.filter(a => a.startsWith("--")));
const dryRun = flags.has("--dry-run");
const force = flags.has("--force");
const proxyArg = argv.find(a => a.startsWith("--proxy="));
const proxyChoice = proxyArg ? proxyArg.split("=")[1] : "caddy";

const c = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

function log(msg) { console.log(`[launcher] ${msg}`); }
function warn(msg) { console.warn(`[launcher] ${c.yellow(msg)}`); }
function err(msg) { console.error(`[launcher] ${c.red(msg)}`); }

function usage() {
  console.log(`Usage: ${c.bold("node scripts/launchers/start.mjs")} <replit|codespace|vps|local> [--dry-run] [--proxy=caddy|nginx]`);
}

if (!profile) {
  err(`Missing or invalid environment argument`);
  usage();
  process.exit(2);
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
  return true;
}

function detectEnv() {
  const isReplit = !!(process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_USER);
  const isCodespaces = String(process.env.CODESPACES).toLowerCase() === "true" || !!process.env.CODESPACE_NAME;
  const isLinux = process.platform === "linux";
  const isMac = process.platform === "darwin";
  const isWsl = !!process.env.WSL_DISTRO_NAME;
  return { isReplit, isCodespaces, isLinux, isMac, isWsl };
}

function validateProfile(env) {
  const fail = (msg) => {
    if (force) { warn(`${msg} — continuing because --force was passed`); return; }
    err(msg);
    err(`Refusing to run ${profile} profile in the wrong environment. Pass --force to override (e.g. for testing).`);
    process.exit(2);
  };
  switch (profile) {
    case "replit":
      if (!env.isReplit) fail("Profile 'replit' requires Replit (no REPL_ID / REPLIT_DEV_DOMAIN detected).");
      break;
    case "codespace":
      if (!env.isCodespaces) fail("Profile 'codespace' requires GitHub Codespaces (CODESPACES=true / CODESPACE_NAME unset).");
      break;
    case "vps":
      if (!env.isLinux) fail("Profile 'vps' requires a Linux host.");
      if (env.isReplit) fail("Profile 'vps' should not be run inside Replit.");
      if (env.isCodespaces) fail("Profile 'vps' should not be run inside Codespaces.");
      break;
    case "local":
      if (env.isReplit) fail("Profile 'local' should not be run inside Replit (use replit-start).");
      if (env.isCodespaces) fail("Profile 'local' should not be run inside Codespaces (use codespace-start).");
      if (process.platform === "win32" && !env.isWsl) fail("Profile 'local' does not support native Windows; use WSL.");
      break;
  }
}

function ensureNodeModules() {
  const nm = path.join(root, "node_modules");
  const lock = path.join(root, "pnpm-lock.yaml");
  const stamp = path.join(nm, ".launcher-install-stamp");
  let needsInstall = !fs.existsSync(nm);
  if (!needsInstall && fs.existsSync(lock)) {
    try {
      const lockMtime = fs.statSync(lock).mtimeMs;
      const stampMtime = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
      if (lockMtime > stampMtime) needsInstall = true;
    } catch { /* ignore */ }
  }
  if (needsInstall) {
    log("node_modules missing or pnpm-lock.yaml newer than install — running pnpm install");
    if (dryRun) { log("(dry-run) pnpm install"); return; }
    const r = spawnSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) { err("pnpm install failed"); process.exit(r.status ?? 1); }
    try { fs.writeFileSync(stamp, String(Date.now())); } catch {}
  }
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}

function parsePgUrl(url) {
  try { return new URL(url); } catch { return null; }
}

function spawnNamed(name, command, args, env) {
  if (dryRun) {
    log(`(dry-run) [${name}] ${command} ${args.join(" ")}`);
    log(`(dry-run) [${name}] env overrides: ${JSON.stringify(env)}`);
    return null;
  }
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", code => {
    if (code !== 0) {
      err(`[${name}] exited with code ${code}`);
      process.exitCode = code ?? 1;
    }
  });
  return child;
}

function printTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  const sep = "+" + widths.map(w => "-".repeat(w + 2)).join("+") + "+";
  const fmt = r => "| " + r.map((cell, i) => String(cell).padEnd(widths[i])).join(" | ") + " |";
  console.log(sep);
  console.log(fmt(rows[0]));
  console.log(sep);
  for (let i = 1; i < rows.length; i++) console.log(fmt(rows[i]));
  console.log(sep);
}

function shellEscape(v) {
  return /^[A-Za-z0-9_./:@%+-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// ---------- shell wrapper installer ----------
function installShellWrappers() {
  const home = os.homedir();
  const binDir = path.join(home, ".local", "bin");
  try { fs.mkdirSync(binDir, { recursive: true }); } catch {}
  const names = ["replit-start", "codespace-start", "vps-start", "local-start"];
  let installed = 0;
  for (const name of names) {
    const src = path.join(__dirname, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(binDir, name);
    try {
      let needs = true;
      if (fs.existsSync(dest)) {
        try {
          const cur = fs.readlinkSync(dest);
          if (path.resolve(path.dirname(dest), cur) === src) needs = false;
        } catch { /* not a symlink */ }
      }
      if (needs) {
        try { fs.unlinkSync(dest); } catch {}
        fs.symlinkSync(src, dest);
        installed++;
      }
      try { fs.chmodSync(src, 0o755); } catch {}
    } catch (e) {
      warn(`Could not install wrapper ${name}: ${e?.message || e}`);
    }
  }
  if (installed > 0) log(`Installed ${installed} shell wrapper(s) into ${binDir}`);
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(binDir)) {
    warn(`Add ${binDir} to your PATH so you can call replit-start / codespace-start / vps-start / local-start directly.`);
    warn(`  e.g. echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`);
  }
}

// ---------- profile: replit ----------
async function profileReplit() {
  log("Detected profile: replit");
  if (!process.env.REPLIT_DEV_DOMAIN) warn("REPLIT_DEV_DOMAIN not set — preview URLs may be unavailable");
  loadEnvFile(path.join(root, ".env"));
  ensureNodeModules();

  const apiPort = process.env.PORT_API || "8080";
  const adminPort = process.env.PORT_ADMIN || "23744";
  const vendorPort = process.env.PORT_VENDOR || "21463";
  const riderPort = process.env.PORT_RIDER || "22969";
  const ajkPort = process.env.PORT_AJK || "20716";
  const sandboxPort = process.env.PORT_SANDBOX || "8081";

  const replitDomain = process.env.REPLIT_DEV_DOMAIN || "";
  const expoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN || replitDomain;

  const services = [
    { name: "api", filter: "@workspace/api-server", script: "dev", env: { PORT: apiPort, NODE_ENV: "development" } },
    { name: "admin", filter: "@workspace/admin", script: "dev", env: { PORT: adminPort, BASE_PATH: "/admin/" } },
    { name: "vendor", filter: "@workspace/vendor-app", script: "dev", env: { PORT: vendorPort, BASE_PATH: "/vendor/" } },
    { name: "rider", filter: "@workspace/rider-app", script: "dev", env: { PORT: riderPort, BASE_PATH: "/rider/" } },
    { name: "ajkmart", filter: "@workspace/ajkmart", script: "dev:web", env: { PORT: ajkPort, BASE_PATH: "/", EXPO_PUBLIC_DOMAIN: expoDomain || `localhost:${apiPort}` } },
    { name: "sandbox", filter: "@workspace/mockup-sandbox", script: "dev", env: { PORT: sandboxPort, BASE_PATH: "/__mockup" } },
  ];

  const children = [];
  for (const s of services) {
    const child = spawnNamed(s.name, "pnpm", ["--filter", s.filter, s.script], s.env);
    if (child) children.push(child);
    log(`${dryRun ? "(dry-run) would start" : "started"} ${s.name} on port ${s.env.PORT}`);
  }

  const base = replitDomain ? `https://${replitDomain}` : `http://localhost:${apiPort}`;
  const expoBase = expoDomain ? `https://${expoDomain}` : `http://localhost:${ajkPort}`;
  printTable([
    ["Service", "Port", "URL"],
    ["api", apiPort, `${base}/api`],
    ["admin", adminPort, `${base}/admin/`],
    ["vendor", vendorPort, `${base}/vendor/`],
    ["rider", riderPort, `${base}/rider/`],
    ["ajkmart (web)", ajkPort, expoBase + "/"],
    ["mockup-sandbox", sandboxPort, `${base}/__mockup`],
  ]);
  if (!dryRun) attachShutdown(children);
}

// ---------- profile: codespace ----------
async function profileCodespace() {
  log("Detected profile: codespace");
  const codespaceName = process.env.CODESPACE_NAME;
  if (!codespaceName) warn("CODESPACE_NAME not set — public URL pattern will fall back to localhost");
  loadEnvFile(path.join(root, ".env"));
  ensureNodeModules();

  const apiPort = process.env.PORT_API || "8080";
  const adminPort = process.env.PORT_ADMIN || "5173";
  const vendorPort = process.env.PORT_VENDOR || "5174";
  const riderPort = process.env.PORT_RIDER || "5175";
  const ajkPort = process.env.PORT_AJK || "19006";

  const publicUrl = (port) =>
    codespaceName ? `https://${codespaceName}-${port}.app.github.dev` : `http://localhost:${port}`;

  const apiBase = publicUrl(apiPort);
  const expoDomain = apiBase.replace(/^https?:\/\//, "");

  // Best-effort: mark public ports
  const ghAvailable = spawnSync("which", ["gh"], { stdio: "ignore" }).status === 0;
  const portsToPublish = [apiPort, adminPort, vendorPort, riderPort, ajkPort];
  if (ghAvailable && codespaceName) {
    for (const p of portsToPublish) {
      const cmd = `gh codespace ports visibility ${p}:public --codespace ${codespaceName}`;
      if (dryRun) { log(`(dry-run) ${cmd}`); continue; }
      spawnSync("sh", ["-c", cmd], { stdio: "ignore" });
    }
  } else if (!ghAvailable) {
    warn("gh CLI not found — set port visibility manually in the Codespaces ports panel");
  }

  const apiTarget = `http://127.0.0.1:${apiPort}`;
  const services = [
    { name: "api", filter: "@workspace/api-server", script: "dev", env: { PORT: apiPort, HOST: "0.0.0.0", NODE_ENV: "development" } },
    { name: "admin", filter: "@workspace/admin", script: "dev", env: { PORT: adminPort, HOST: "0.0.0.0", BASE_PATH: "/admin/", VITE_API_PROXY_TARGET: apiTarget } },
    { name: "vendor", filter: "@workspace/vendor-app", script: "dev", env: { PORT: vendorPort, HOST: "0.0.0.0", BASE_PATH: "/vendor/", VITE_API_PROXY_TARGET: apiTarget } },
    { name: "rider", filter: "@workspace/rider-app", script: "dev", env: { PORT: riderPort, HOST: "0.0.0.0", BASE_PATH: "/rider/", VITE_API_PROXY_TARGET: apiTarget } },
    {
      name: "ajkmart",
      filter: "@workspace/ajkmart",
      script: "dev:web",
      env: {
        PORT: ajkPort,
        BASE_PATH: "/",
        EXPO_PUBLIC_DOMAIN: expoDomain,
        // ajkmart's dev:web hardcodes EXPO_PUBLIC_DOMAIN=$REPLIT_DEV_DOMAIN,
        // so we shadow that var in Codespaces with the public hostname.
        REPLIT_DEV_DOMAIN: expoDomain,
        REPLIT_EXPO_DEV_DOMAIN: expoDomain,
        REPL_ID: process.env.REPL_ID || codespaceName || "codespace",
      },
    },
  ];

  const children = [];
  for (const s of services) {
    const child = spawnNamed(s.name, "pnpm", ["--filter", s.filter, s.script], s.env);
    if (child) children.push(child);
    log(`${dryRun ? "(dry-run) would start" : "started"} ${s.name} on port ${s.env.PORT}`);
  }

  printTable([
    ["Service", "Port", "Public URL"],
    ["api", apiPort, `${publicUrl(apiPort)}/api`],
    ["admin", adminPort, `${publicUrl(adminPort)}/admin/`],
    ["vendor", vendorPort, `${publicUrl(vendorPort)}/vendor/`],
    ["rider", riderPort, `${publicUrl(riderPort)}/rider/`],
    ["ajkmart (web)", ajkPort, publicUrl(ajkPort) + "/"],
  ]);
  if (!dryRun) attachShutdown(children);
}

// ---------- profile: vps ----------
function hasCmd(cmd) {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function tryInstallApt(pkgs) {
  const isRoot = process.getuid && process.getuid() === 0;
  const sudo = isRoot ? "" : (hasCmd("sudo") ? "sudo " : "");
  const cmd = `${sudo}apt-get update -y && ${sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs.join(" ")}`;
  log(`Installing system packages: ${pkgs.join(", ")}`);
  if (dryRun) { log(`(dry-run) ${cmd}`); return true; }
  const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
  return r.status === 0;
}

function reloadCaddyOrNginx(proxy) {
  const isRoot = process.getuid && process.getuid() === 0;
  const sudo = isRoot ? "" : (hasCmd("sudo") ? "sudo " : "");
  if (proxy === "nginx") {
    const cp = `${sudo}cp deploy/nginx.conf /etc/nginx/sites-available/ajkmart && ${sudo}ln -sf /etc/nginx/sites-available/ajkmart /etc/nginx/sites-enabled/ajkmart && ${sudo}nginx -t && ${sudo}systemctl reload nginx`;
    log("Installing nginx site config and reloading nginx");
    if (dryRun) { log(`(dry-run) ${cp}`); return; }
    spawnSync("sh", ["-c", cp], { stdio: "inherit" });
  } else {
    const cp = `${sudo}cp deploy/Caddyfile /etc/caddy/Caddyfile && ${sudo}systemctl reload caddy`;
    log("Installing Caddyfile and reloading caddy");
    if (dryRun) { log(`(dry-run) ${cp}`); return; }
    spawnSync("sh", ["-c", cp], { stdio: "inherit" });
  }
}

async function profileVps() {
  log("Detected profile: vps");
  loadEnvFile(path.join(root, ".env")) || warn(".env not found at project root — VPS run usually expects one");

  // ensure tooling
  if (!hasCmd("node")) {
    log("node missing — installing Node.js 20 (NodeSource)");
    const isRoot = process.getuid && process.getuid() === 0;
    const sudo = isRoot ? "" : (hasCmd("sudo") ? "sudo " : "");
    if (!hasCmd("curl")) tryInstallApt(["curl", "ca-certificates", "gnupg"]);
    const cmd = `curl -fsSL https://deb.nodesource.com/setup_20.x | ${sudo}bash - && ${sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs`;
    if (dryRun) {
      log(`(dry-run) ${cmd}`);
    } else {
      const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
      if (r.status !== 0 || !hasCmd("node")) {
        err("Could not install Node.js automatically. Install Node 20+ manually and re-run vps-start.");
        process.exit(1);
      }
    }
  }
  if (!hasCmd("corepack")) {
    log("corepack missing — installing via apt");
    tryInstallApt(["nodejs"]);
  }
  if (!hasCmd("pnpm")) {
    log("pnpm missing — enabling via corepack");
    if (!dryRun) {
      const isRoot = process.getuid && process.getuid() === 0;
      const sudo = isRoot ? "" : (hasCmd("sudo") ? "sudo " : "");
      spawnSync("sh", ["-c", `${sudo}corepack enable && ${sudo}corepack prepare pnpm@latest --activate`], { stdio: "inherit" });
    }
  }
  const missingApt = [];
  if (!hasCmd(proxyChoice)) missingApt.push(proxyChoice);
  if (missingApt.length) tryInstallApt(missingApt);
  if (!hasCmd("pm2")) {
    log("pm2 missing — installing via pnpm (global)");
    if (!dryRun) spawnSync("pnpm", ["add", "-g", "pm2"], { stdio: "inherit" });
  }

  // install deps
  log("Running pnpm install --frozen-lockfile");
  if (!dryRun) {
    const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) {
      warn("frozen install failed, retrying without --frozen-lockfile");
      const r2 = spawnSync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, stdio: "inherit" });
      if (r2.status !== 0) { err("pnpm install failed"); process.exit(r2.status ?? 1); }
    }
  } else {
    log("(dry-run) pnpm install --frozen-lockfile");
  }

  // db schema
  log("Pushing DB schema");
  if (!dryRun) {
    const r = spawnSync("pnpm", ["--filter", "@workspace/db", "push"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) warn("DB push reported errors — review output");
  } else {
    log("(dry-run) pnpm --filter @workspace/db push");
  }

  // production build
  log("Building production artifacts");
  if (!dryRun) {
    const r = spawnSync("node", ["scripts/build-production.mjs"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) { err("Production build failed"); process.exit(r.status ?? 1); }
  } else {
    log("(dry-run) node scripts/build-production.mjs");
  }

  // pm2
  log("Starting PM2 processes");
  if (!dryRun) {
    spawnSync("node", ["scripts/pm2-control.mjs", "start"], { cwd: root, stdio: "inherit" });
  } else {
    log("(dry-run) node scripts/pm2-control.mjs start");
  }

  // proxy
  reloadCaddyOrNginx(proxyChoice);

  // health probe
  const apiPort = process.env.API_PORT || "8080";
  const mobilePort = process.env.MOBILE_WEB_PORT || "19006";
  let apiOk = false, mobileOk = false;
  if (!dryRun) {
    apiOk = await probeTcp("127.0.0.1", Number(apiPort));
    mobileOk = await probeTcp("127.0.0.1", Number(mobilePort));
  }

  const domain = process.env.AJKMART_DOMAIN || "localhost";
  printTable([
    ["Service", "Port", "URL", "Status"],
    ["api (pm2)", apiPort, `https://${domain}/api`, dryRun ? "dry-run" : (apiOk ? c.green("up") : c.red("down"))],
    ["customer web (pm2)", mobilePort, `https://${domain}/`, dryRun ? "dry-run" : (mobileOk ? c.green("up") : c.red("down"))],
    ["admin (static)", "-", `https://${domain}/admin/`, "served by " + proxyChoice],
    ["vendor (static)", "-", `https://${domain}/vendor/`, "served by " + proxyChoice],
    ["rider (static)", "-", `https://${domain}/rider/`, "served by " + proxyChoice],
    ["mockup-sandbox", "-", "(not deployed in vps profile)", "skipped"],
  ]);
}

// ---------- profile: local ----------
async function profileLocal() {
  log("Detected profile: local");
  if (process.platform === "win32" && !process.env.WSL_DISTRO_NAME) {
    err("local profile only supports macOS, Linux, or WSL. Use WSL on Windows.");
    process.exit(1);
  }

  // .env bootstrap
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    const example = path.join(root, "deploy", "env.example");
    if (fs.existsSync(example)) {
      log(".env missing — copying deploy/env.example -> .env");
      if (!dryRun) fs.copyFileSync(example, envPath);
    } else {
      warn(".env missing and deploy/env.example not found; create one before running services that need DB");
    }
  }
  loadEnvFile(envPath);

  ensureNodeModules();

  // probe DB
  const dbUrl = process.env.NEON_DATABASE_URL || process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
  if (dbUrl) {
    const u = parsePgUrl(dbUrl);
    if (u && u.hostname && u.port) {
      const port = Number(u.port) || 5432;
      const ok = dryRun ? true : await probeTcp(u.hostname, port, 2000);
      if (!ok) warn(`Postgres at ${u.hostname}:${port} is not reachable — services may fail`);
      else log(`Postgres reachable at ${u.hostname}:${port}`);
    }
  } else {
    warn("No database URL set; API and migrations will fail");
  }

  // delegate to existing run-dev-all.mjs
  const runner = path.join(root, "scripts", "run-dev-all.mjs");
  log(`Delegating to ${runner}`);
  if (dryRun) {
    log(`(dry-run) node ${runner}`);
    printTable([
      ["Service", "Port", "URL"],
      ["api", "8080", "http://localhost:8080/api"],
      ["admin", "5173", "http://localhost:5173/admin/"],
      ["vendor", "5174", "http://localhost:5174/vendor/"],
      ["rider", "5175", "http://localhost:5175/rider/"],
      ["ajkmart (web)", "19006", "http://localhost:19006"],
      ["mockup-sandbox", "8081", "http://localhost:8081/__mockup"],
    ]);
    return;
  }

  // Also start mockup-sandbox alongside (run-dev-all does not include it)
  const sandbox = spawnNamed("sandbox", "pnpm", ["--filter", "@workspace/mockup-sandbox", "dev"], {
    PORT: process.env.PORT_SANDBOX || process.env.SANDBOX_PORT || "8081",
    BASE_PATH: "/__mockup",
  });

  const child = spawn("node", [runner], {
    cwd: root,
    env: { ...process.env },
    stdio: "inherit",
  });
  child.on("exit", code => process.exit(code ?? 0));

  printTable([
    ["Service", "Port", "URL"],
    ["api", "8080", "http://localhost:8080/api"],
    ["admin", "5173", "http://localhost:5173/admin/"],
    ["vendor", "5174", "http://localhost:5174/vendor/"],
    ["rider", "5175", "http://localhost:5175/rider/"],
    ["ajkmart (web)", "19006", "http://localhost:19006"],
    ["mockup-sandbox", "8081", "http://localhost:8081/__mockup"],
  ]);

  attachShutdown([child, sandbox].filter(Boolean));
}

function attachShutdown(children) {
  const shutdown = () => {
    for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------- main ----------
(async () => {
  installShellWrappers();
  const env = detectEnv();
  log(`Profile=${profile} dryRun=${dryRun} force=${force} platform=${process.platform} replit=${env.isReplit} codespaces=${env.isCodespaces} wsl=${env.isWsl}`);
  validateProfile(env);

  switch (profile) {
    case "replit":    await profileReplit(); break;
    case "codespace": await profileCodespace(); break;
    case "vps":       await profileVps(); break;
    case "local":     await profileLocal(); break;
  }
})().catch(e => {
  err(e?.stack || String(e));
  process.exit(1);
});
