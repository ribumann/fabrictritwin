import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

function start(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  children.add(child);
  child.on("error", (error) => {
    console.error(`[demo] Could not start ${command}: ${error.message}`);
    stop(1);
  });
  child.on("exit", () => children.delete(child));
  return child;
}

async function npm(args) {
  const child = process.platform === "win32"
    ? start(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`])
    : start("npm", args);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !stopping) resolve();
      else reject(new Error(`npm ${args[0]} exited (${signal ?? code}).`));
    });
  });
}

async function requireFreePort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is occupied. Stop that service before starting the demo.`)));
    probe.listen(port, () => probe.close(resolve));
  });
}

async function waitForReady(child, port, service) {
  const deadline = Date.now() + 20_000;
  while (!stopping && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      const health = await response.json();
      if (response.ok && health.service === service) return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(200);
  }
  throw new Error(`${service} did not become ready on port ${port}.`);
}

try {
  await Promise.all([requireFreePort(3000), requireFreePort(3300)]);
  await npm(["ci", "--no-audit", "--no-fund"]);
  await npm(["run", "build"]);
  if (!stopping) {
    const env = { ...process.env, DEMO_PROFILE: "synthetic" };
    const backend = start(process.execPath, [path.join(root, "apps", "streaming-backend", "dist", "index.js")], {
      ...env, PORT: "3000",
    });
    const cockpit = start(process.execPath, [path.join(root, "apps", "cockpit", "dist", "index.js")], {
      ...env, PORT: "3300", STREAMING_BACKEND_BASE_URL: "http://127.0.0.1:3000",
    });
    for (const child of [backend, cockpit]) {
      child.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(`[demo] A service exited (${signal ?? code}); stopping both services.`);
          stop(1);
        }
      });
    }
    await Promise.all([
      waitForReady(backend, 3000, "streaming-backend"),
      waitForReady(cockpit, 3300, "cockpit"),
    ]);
    if (!stopping) console.log("[demo] Synthetic Cockpit ready: http://localhost:3300 — Ctrl+C stops both services.");
  }
} catch (error) {
  if (!stopping) console.error(`[demo] ${error.message}`);
  stop(1);
}
