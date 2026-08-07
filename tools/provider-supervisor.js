#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const APP_NAME = "codex-context-used-meter";
const PIPE_NAME = "\\\\.\\pipe\\codex-context-meter-provider-supervisor";
const POLL_INTERVAL_MS = 2500;
const CODEX_EXIT_GRACE_MS = 8000;
const HELPER_RESTART_DELAY_MS = 5000;
const HELPER_STOP_GRACE_MS = 4000;
const MAX_LOG_BYTES = 512 * 1024;

const repoRoot = path.resolve(__dirname, "..");
const helperPath = path.join(__dirname, "provider-helper.js");
const configDir = path.join(process.env.APPDATA || repoRoot, APP_NAME);
const logPath = path.join(configDir, "provider-supervisor.log");

let helperProcess = null;
let helperStopping = false;
let helperRestartTimer = null;
let lastCodexSeenAt = 0;
let pollTimer = null;
let shuttingDown = false;
let instanceServer = null;

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= MAX_LOG_BYTES) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {}
}

function log(message) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {}
}

function createSingleInstanceServer() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        process.exit(0);
        return;
      }
      log(`single-instance pipe failed: ${error && error.message ? error.message : "unknown-error"}`);
      resolve(null);
    });
    server.listen(PIPE_NAME, () => resolve(server));
  });
}

function isCodexReady() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(false);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('Codex.exe','ChatGPT.exe')) -and $_.CommandLine -match '--remote-debugging-port=\\d+' }; if($p){'1'}else{'0'}",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          log(`codex process probe failed: ${error.message}`);
          resolve(false);
          return;
        }
        resolve(String(stdout || "").trim().includes("1"));
      },
    );
  });
}

function appendHelperOutput(stream, prefix) {
  if (!stream) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      log(`${prefix}: ${line.slice(0, 500)}`);
    }
  });
}

function scheduleHelperRestart() {
  if (shuttingDown || helperRestartTimer) return;
  helperRestartTimer = setTimeout(() => {
    helperRestartTimer = null;
    tick().catch((error) => log(`restart tick failed: ${error && error.message ? error.message : "unknown-error"}`));
  }, HELPER_RESTART_DELAY_MS);
}

function startHelper() {
  if (helperProcess || helperStopping || shuttingDown) return;
  if (!fs.existsSync(helperPath)) {
    log(`provider helper not found: ${helperPath}`);
    return;
  }

  helperProcess = spawn(process.execPath, [helperPath], {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  log(`provider helper started: pid=${helperProcess.pid}`);
  appendHelperOutput(helperProcess.stdout, "helper stdout");
  appendHelperOutput(helperProcess.stderr, "helper stderr");

  helperProcess.once("exit", (code, signal) => {
    log(`provider helper exited: code=${code == null ? "" : code} signal=${signal || ""}`);
    helperProcess = null;
    helperStopping = false;
    if (!shuttingDown && Date.now() - lastCodexSeenAt <= CODEX_EXIT_GRACE_MS) {
      scheduleHelperRestart();
    }
  });
}

function stopHelper(reason) {
  if (!helperProcess || helperStopping) return;
  const child = helperProcess;
  helperStopping = true;
  log(`stopping provider helper: reason=${reason} pid=${child.pid}`);
  try {
    child.kill("SIGTERM");
  } catch {}

  setTimeout(() => {
    if (helperProcess !== child) return;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, HELPER_STOP_GRACE_MS).unref();
}

async function tick() {
  const codexReady = await isCodexReady();
  const now = Date.now();
  if (codexReady) {
    lastCodexSeenAt = now;
    startHelper();
    return;
  }

  if (helperProcess && now - lastCodexSeenAt > CODEX_EXIT_GRACE_MS) {
    stopHelper("codex-not-running");
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (helperRestartTimer) clearTimeout(helperRestartTimer);
  if (pollTimer) clearInterval(pollTimer);
  stopHelper("supervisor-exit");
  if (instanceServer) {
    try {
      instanceServer.close();
    } catch {}
  }
  setTimeout(() => process.exit(0), HELPER_STOP_GRACE_MS + 500).unref();
}

async function main() {
  instanceServer = await createSingleInstanceServer();
  log("provider supervisor started");
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  await tick();
  pollTimer = setInterval(() => {
    tick().catch((error) => log(`tick failed: ${error && error.message ? error.message : "unknown-error"}`));
  }, POLL_INTERVAL_MS);
}

main().catch((error) => {
  log(`provider supervisor failed: ${error && error.message ? error.message : "unknown-error"}`);
  process.exitCode = 1;
});
