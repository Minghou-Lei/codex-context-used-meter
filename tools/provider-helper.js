#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_DIR = path.join(process.env.APPDATA || process.cwd(), "codex-context-used-meter");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "provider-config.json");
const DEFAULT_SECRETS_PATH = path.join(DEFAULT_CONFIG_DIR, "provider-secrets.json");
const DEFAULT_UI_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "ui-config.json");
const DEFAULT_USER_AGENT = "CodexContextMeterProviderHelper/1.0";
const DEFAULT_CODEX_DEBUG_PORT = 9229;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CDP_HTTP_TIMEOUT_MS = 3000;
const CDP_CONNECT_TIMEOUT_MS = 4000;
const CDP_COMMAND_TIMEOUT_MS = 4000;
const DEFAULT_PROVIDER_REFRESH_INTERVAL_MS = 10000;
const PROVIDER_SUMMARY_KEY = "__codexContextMeterProviderSummary";
const PROVIDER_SUMMARY_EVENT = "codex-context-meter-provider-summary";

  const DEFAULT_UI_CONFIG = {
    context: {
    showUsedInsteadOfLeft: false,
    compressionWarningLeftPercent: 20,
    levelThresholds: {
      criticalLeftPercent: 30,
      dangerLeftPercent: 40,
      warnLeftPercent: 50,
      noticeLeftPercent: 60,
    },
  },
  provider: {
    levelThresholds: {
      criticalLeftPercent: 30,
      dangerLeftPercent: 40,
      warnLeftPercent: 50,
      noticeLeftPercent: 60,
    },
  },
};

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw new Error(`Failed to read JSON file: ${filePath}`);
  }
}

function parseArgs(argv) {
  const options = {
    once: false,
    noCdp: false,
    printSummary: false,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg === "--once") options.once = true;
    else if (arg === "--no-cdp") options.noCdp = true;
    else if (arg === "--print-summary") options.printSummary = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return [
    "Usage: node tools/provider-helper.js [--once] [--no-cdp] [--print-summary] [--verbose]",
    "",
    "Reads private provider config, requests provider quota directly, and pushes a sanitized summary into Codex via CDP.",
    "Config:  CCM_PROVIDER_CONFIG  or %APPDATA%\\codex-context-used-meter\\provider-config.json",
    "Secrets: CCM_PROVIDER_SECRETS or %APPDATA%\\codex-context-used-meter\\provider-secrets.json",
    "UI:      CCM_UI_CONFIG        or %APPDATA%\\codex-context-used-meter\\ui-config.json",
  ].join("\n");
}

function providerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function classifyProviderError(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code) return code;
  if (error && error.name === "AbortError") return "request-timeout";
  return "request-failed";
}

function isSafeProviderUrl(url) {
  if (url.protocol !== "https:") return false;

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    return false;
  }

  if (/^(10|127|169\.254|172\.(1[6-9]|2\d|3[0-1])|192\.168)\./.test(hostname)) {
    return false;
  }

  return true;
}

function getSecret(secrets, name) {
  if (!name) return "";
  const value = secrets && secrets[name];
  return value == null ? "" : String(value);
}

function buildProviderUrl(provider) {
  const baseUrl = String(provider.baseUrl || "").trim();
  const endpointPath = String(provider.endpointPath || "").trim() || "/";
  let url;
  try {
    url = new URL(endpointPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw providerError("invalid-provider-url");
  }

  if (!isSafeProviderUrl(url)) {
    throw providerError("unsafe-provider-url");
  }

  return url;
}

function buildProviderHeaders(provider, secrets) {
  const headers = {
    Accept: "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
  };

  if (provider.auth && provider.auth.type === "bearer") {
    const token = getSecret(secrets, provider.auth.accessTokenSecret);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  if (provider.userHeader && provider.userHeader.name) {
    const headerName = String(provider.userHeader.name);
    const headerValue = getSecret(secrets, provider.userHeader.valueSecret);
    if (headerValue) headers[headerName] = headerValue;
  }

  return headers;
}

function findSubscriptionContainer(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload;

  const containers = [];
  const seen = new WeakSet();

  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      containers.push(value);
      return;
    }

    for (const key of ["subscriptions", "all_subscriptions", "subscription", "items", "result", "data"]) {
      const child = value[key];
      if (!child || typeof child !== "object") continue;
      if (Array.isArray(child)) containers.push(child);
      else if (key === "subscription") containers.push([child]);
      else visit(child, depth + 1);
    }
  }

  visit(payload, 0);
  return containers[0] || [payload];
}

function flattenSubscriptionItems(items) {
  const output = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.subscription && typeof item.subscription === "object") output.push(item.subscription);
    else output.push(item);
  }
  return output;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSubscription(provider, payload) {
  const wallet = normalizeWalletBalance(provider, payload);
  if (wallet) return wallet;

  const subscriptions = flattenSubscriptionItems(findSubscriptionContainer(payload));
  const active = subscriptions.find((item) => item && String(item.status || "").toLowerCase() === "active");
  const updatedAt = Math.floor(Date.now() / 1000);
  const displayName = provider.displayName || provider.id || "Provider";
  const id = provider.id || "provider";

  if (!active) {
    return {
      id,
      displayName,
      status: "no-active-subscription",
      updatedAt,
    };
  }

  const total = toFiniteNumber(active.total ?? active.amount_total ?? active.amountTotal);
  const used = toFiniteNumber(active.used ?? active.amount_used ?? active.amountUsed);
  const expiresAt = toFiniteNumber(active.end_time || active.endTime || active.expires_at || active.expiresAt);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) {
    return {
      id,
      displayName,
      status: "invalid-subscription",
      updatedAt,
    };
  }

  const divisor = toFiniteNumber(provider.quota && provider.quota.amountDivisor) || 500000;
  const safeUsed = Math.min(used, total);
  const remaining = Math.max(0, total - safeUsed);
  return {
    id,
    displayName,
    status: "active",
    currency: active.currency ? String(active.currency) : "USD",
    used: safeUsed,
    total,
    remaining,
    usedPercent: Math.max(0, Math.min(100, (safeUsed / total) * 100)),
    usedAmount: safeUsed / divisor,
    remainingAmount: remaining / divisor,
    totalAmount: total / divisor,
    expiresAt,
    updatedAt,
  };
}

function normalizeWalletBalance(provider, payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.balance_infos)) return null;

  const info =
    payload.balance_infos.find((item) => item && typeof item === "object" && item.currency) ||
    payload.balance_infos[0];
  const total = toFiniteNumber(info && info.total_balance);
  const id = provider.id || "provider";
  const displayName = provider.displayName || id;
  const updatedAt = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(total) || total < 0) {
    return {
      id,
      displayName,
      status: "invalid-balance",
      updatedAt,
    };
  }

  const divisor = toFiniteNumber(provider.quota && provider.quota.amountDivisor) || 500000;
  const amount = total / divisor;
  return {
    id,
    displayName,
    status: payload.is_available === false ? "unavailable" : "active",
    kind: "wallet",
    currency: info ? String(info.currency || "CNY") : "CNY",
    total,
    used: 0,
    remaining: total,
    usedPercent: 0,
    usedAmount: amount,
    remainingAmount: amount,
    totalAmount: amount,
    updatedAt,
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLevelThresholds(value, defaults) {
  const input = value && typeof value === "object" ? value : {};

  return {
    criticalLeftPercent: clampPercent(numberOrDefault(input.criticalLeftPercent, defaults.criticalLeftPercent)),
    dangerLeftPercent: clampPercent(numberOrDefault(input.dangerLeftPercent, defaults.dangerLeftPercent)),
    warnLeftPercent: clampPercent(numberOrDefault(input.warnLeftPercent, defaults.warnLeftPercent)),
    noticeLeftPercent: clampPercent(numberOrDefault(input.noticeLeftPercent, defaults.noticeLeftPercent)),
  };
}

function normalizeUiConfig(ui) {
  const input = ui && typeof ui === "object" ? ui : {};
  const context = input.context && typeof input.context === "object" ? input.context : {};
  const provider = input.provider && typeof input.provider === "object" ? input.provider : {};

  return {
    context: {
      showUsedInsteadOfLeft: context.showUsedInsteadOfLeft === true,
      compressionWarningLeftPercent: clampPercent(numberOrDefault(
        context.compressionWarningLeftPercent,
        DEFAULT_UI_CONFIG.context.compressionWarningLeftPercent,
      )),
      levelThresholds: normalizeLevelThresholds(
        context.levelThresholds,
        DEFAULT_UI_CONFIG.context.levelThresholds,
      ),
    },
    provider: {
      levelThresholds: normalizeLevelThresholds(
        provider.levelThresholds,
        DEFAULT_UI_CONFIG.provider.levelThresholds,
      ),
    },
  };
}

async function fetchProvider(provider, secrets) {
  const url = buildProviderUrl(provider);
  const headers = buildProviderHeaders(provider, secrets);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw providerError("response-too-large");
    }
    if (!response.ok) throw providerError("http-error");
    if (!/json/i.test(contentType)) throw providerError("not-json");

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw providerError("response-too-large");
    try {
      return normalizeSubscription(provider, JSON.parse(text));
    } catch {
      throw providerError("invalid-json");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function createState(config, secrets) {
  return {
    config,
    secrets,
    ui: normalizeUiConfig(config.ui),
    configLoadError: null,
    inFlight: null,
  };
}

function minRefreshInterval(config) {
  const intervals = (config.providers || [])
    .map((provider) => Number(provider.refreshIntervalMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  return intervals.length ? Math.min(...intervals) : DEFAULT_PROVIDER_REFRESH_INTERVAL_MS;
}

async function getSummary(state) {
  if (state.inFlight) return state.inFlight;

  if (state.configLoadError) {
    return {
      providers: [],
      ui: state.ui,
      status: "config-error",
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }

  state.inFlight = Promise.all((state.config.providers || []).map(async (provider) => {
    const id = provider.id || "provider";
    const displayName = provider.displayName || id;
    try {
      return await fetchProvider(provider, state.secrets);
    } catch (error) {
      return {
        id,
        displayName,
        status: "error",
        error: classifyProviderError(error),
        updatedAt: Math.floor(Date.now() / 1000),
      };
    }
  }))
    .then((providers) => ({
      providers,
      ui: state.ui,
      updatedAt: Math.floor(Date.now() / 1000),
    }))
    .finally(() => {
      state.inFlight = null;
    });

  return state.inFlight;
}

function loadConfig() {
  const configPath = process.env.CCM_PROVIDER_CONFIG || DEFAULT_CONFIG_PATH;
  const secretsPath = process.env.CCM_PROVIDER_SECRETS || DEFAULT_SECRETS_PATH;
  const uiConfigPath = process.env.CCM_UI_CONFIG || DEFAULT_UI_CONFIG_PATH;
  let config = { providers: [] };
  let secrets = {};
  let uiConfig = null;
  let configError = null;
  let secretsError = null;
  let uiConfigError = null;

  try {
    config = readJsonFile(configPath, { providers: [] });
  } catch (error) {
    configError = error;
  }

  try {
    secrets = readJsonFile(secretsPath, {});
  } catch (error) {
    secretsError = error;
  }

  try {
    uiConfig = readJsonFile(uiConfigPath, null);
  } catch (error) {
    uiConfigError = error;
  }

  if (!Array.isArray(config.providers)) config.providers = [];
  if (!config.codex || typeof config.codex !== "object") config.codex = {};
  config.ui = uiConfig || DEFAULT_UI_CONFIG;
  return { config, secrets, configPath, secretsPath, uiConfigPath, configError, secretsError, uiConfigError };
}

function debugPort(config) {
  const value = Number(process.env.CCM_CODEX_DEBUG_PORT || config.codex.debugPort || DEFAULT_CODEX_DEBUG_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_CODEX_DEBUG_PORT;
}

function configuredDebugPorts(config) {
  const values = [
    process.env.CCM_CODEX_DEBUG_PORT,
    config.codex.debugPort,
    ...(Array.isArray(config.codex.debugPorts) ? config.codex.debugPorts : []),
    DEFAULT_CODEX_DEBUG_PORT,
  ];
  const output = [];
  for (const value of values) {
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || output.includes(port)) continue;
    output.push(port);
  }
  return output;
}

function candidateDebugPortsFromProcesses() {
  if (process.platform !== "win32") return [];

  try {
    const { execFileSync } = require("node:child_process");
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('Codex.exe','ChatGPT.exe')) -and $_.CommandLine -match '--remote-debugging-port=(\\d+)' } | ForEach-Object { if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') { $Matches[1] } }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 3000 },
    );
    return output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((port, index, array) =>
        Number.isInteger(port) && port > 0 && port <= 65535 && array.indexOf(port) === index
      );
  } catch {
    return [];
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("http-error");
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function listCdpTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`, CDP_HTTP_TIMEOUT_MS);
  return Array.isArray(targets) ? targets : [];
}

function pickCdpTarget(targets, config) {
  const targetsToPublish = pickCdpTargets(targets, config);
  return targetsToPublish[0] || null;
}

function pickCdpTargets(targets, config) {
  const hint = String(config.codex.targetUrlHint || "codex").toLowerCase();
  const pages = targets.filter((target) =>
    target &&
    target.type === "page" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    target.webSocketDebuggerUrl
  );

  if (!pages.length) return [];
  const scored = pages.map((target) => {
    const haystack = `${target.title || ""} ${target.url || ""}`.toLowerCase();
    const url = String(target.url || "").toLowerCase();
    let score = 0;
    if (url === "app://-/index.html") score += 10;
    if (url.includes("avatar-overlay") || url.includes("hotkey-window") || url.includes("pet")) score -= 20;
    if (hint && haystack.includes(hint)) score += 4;
    if (haystack.includes("codex")) score += 3;
    if (haystack.includes("app://-/index.html")) score += 2;
    return { target, score };
  });

  scored.sort((left, right) => right.score - left.score);
  const publishable = scored
    .filter((item) => item.score > 0)
    .map((item) => item.target);
  return publishable.length ? publishable : [scored[0].target];
}

function connectWebSocket(url) {
  if (typeof WebSocket !== "function") {
    return Promise.reject(new Error("Current Node.js runtime does not provide WebSocket."));
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error("cdp-connect-timeout"));
    }, CDP_CONNECT_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("cdp-connect-failed"));
    }, { once: true });
  });
}

function sendCdpCommand(socket, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("cdp-command-timeout"));
    }, CDP_COMMAND_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }

    function onError() {
      cleanup();
      reject(new Error("cdp-command-failed"));
    }

    function onMessage(event) {
      let payload;
      try {
        payload = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }
      if (payload.id !== id) return;

      cleanup();
      if (payload.error) reject(new Error("cdp-command-error"));
      else resolve(payload.result || {});
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function providerSummaryExpression(summary) {
  const summaryJson = JSON.stringify(summary);
  return `
(() => {
  const summary = ${summaryJson};
  window.${PROVIDER_SUMMARY_KEY} = summary;
  try {
    window.__codexContextMeter?.setProviderSummary?.(summary);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(${JSON.stringify(PROVIDER_SUMMARY_EVENT)}, { detail: summary }));
  } catch {}
  return { ok: true, providers: Array.isArray(summary.providers) ? summary.providers.length : 0 };
})()
`;
}

async function publishSummaryToCodex(config, summary) {
  const ports = Array.from(new Set([
    ...configuredDebugPorts(config),
    ...candidateDebugPortsFromProcesses(),
  ]));
  let lastError = null;
  let publishCount = 0;

  for (const port of ports) {
    try {
      const targets = await listCdpTargets(port);
      const publishTargets = pickCdpTargets(targets, config);
      if (!publishTargets.length) continue;

      for (const target of publishTargets) {
        let socket = null;
        try {
          socket = await connectWebSocket(target.webSocketDebuggerUrl);
          await sendCdpCommand(socket, 1, "Runtime.evaluate", {
            expression: providerSummaryExpression(summary),
            awaitPromise: false,
            allowUnsafeEvalBlockedByCSP: true,
          });
          publishCount += 1;
        } catch (error) {
          lastError = error;
        } finally {
          if (socket) {
            try {
              socket.close();
            } catch {}
          }
        }
      }

      if (publishCount > 0) return { ok: true, targets: publishCount };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("cdp-target-not-found");
}

async function runOnce(state, options) {
  const summary = await getSummary(state);
  if (options.printSummary) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }

  if (!options.noCdp) {
    await publishSummaryToCodex(state.config, summary);
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { config, secrets, configError, secretsError } = loadConfig();
  const state = createState(config, secrets);
  state.configLoadError = configError || secretsError;
  const intervalMs = minRefreshInterval(config);
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      const summary = await runOnce(state, options);
      const activeCount = (summary.providers || []).filter((provider) => provider.status === "active").length;
      if (options.once || options.verbose) {
        console.log(`Provider summary updated. providers=${summary.providers.length} active=${activeCount}`);
      }
    } catch (error) {
      console.error(`Provider summary update failed: ${error && error.message ? error.message : "unknown-error"}`);
    } finally {
      tickInProgress = false;
    }
  };

  await tick();
  if (options.once) return;
  setInterval(tick, intervalMs);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : "Provider helper failed.");
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeSubscription,
  normalizeUiConfig,
  buildProviderUrl,
  isSafeProviderUrl,
  providerSummaryExpression,
  pickCdpTarget,
  pickCdpTargets,
};
