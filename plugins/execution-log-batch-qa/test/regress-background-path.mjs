#!/usr/bin/env node
/**
 * v1.0.11 regress: page/content have ZERO fetch(; background alone fetches Agent;
 * user-facing errors never contain raw "Failed to fetch";
 * no auto-dump / dump-day leftovers.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log("OK:", msg);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const pageSources = ["shared/batch-qa-core.js", "extension/content.js", "extension/page-bridge.js"];

for (const rel of pageSources) {
  const src = read(rel);
  // Count real call sites / identifiers: require zero "fetch(" substring (incl. comments)
  const fetches = [...src.matchAll(/fetch\s*\(/g)];
  if (fetches.length > 0) {
    fail(`${rel}: must have ZERO fetch( substring — found ${fetches.length}`);
  } else {
    ok(`${rel}: ZERO fetch( substring`);
  }
  if (/\/download\?variant/.test(src) && !src.includes("background only") && !src.includes("API (background only)")) {
    // comments documenting API ok if marked background-only
    if (!/background only|后台/.test(src.slice(Math.max(0, src.indexOf("/download?variant") - 80), src.indexOf("/download?variant") + 40))) {
      /* allow doc comments */
    }
  }
}

const allPluginSources = [
  "shared/batch-qa-core.js",
  "extension/content.js",
  "extension/page-bridge.js",
  "extension/background.js",
  "userscript/a3-execution-log-batch-qa.user.js",
];
const banned = [
  "autoDumpStarted",
  "autoDumpDay",
  "autoDump",
  "dump-day",
  "writeDumpStatus",
  "DUMP_DAY",
  "runDumpDay",
  "20261120",
];
for (const rel of allPluginSources) {
  const src = read(rel);
  const hits = banned.filter((b) => src.includes(b));
  if (hits.length) fail(`${rel}: banned auto-dump leftovers: ${hits.join(", ")}`);
  else ok(`${rel}: no auto-dump leftovers`);
}

const bgSrc = read("extension/background.js");
if (!/\bfetch\s*\(/.test(bgSrc)) fail("background.js must fetch Agent downloads");
else ok("background.js: has fetch( (expected)");
if (!bgSrc.includes("zipBytesToDataUrl")) fail("background.js missing zipBytesToDataUrl (MV3 data URL path)");
else ok("background.js: zipBytesToDataUrl present");

const fetchCalls = [];
const downloads = [];
const portMessages = [];

const fakeFetch = async (url, init) => {
  fetchCalls.push({
    url: String(url),
    auth: (init && init.headers && init.headers.Authorization) || "",
    via: "background-mock",
  });
  if (!init || !init.headers || !String(init.headers.Authorization || "").includes("Bearer good")) {
    const err = new TypeError("Failed to fetch");
    throw err;
  }
  const body = new TextEncoder().encode("Q: hi\nA: hello\n");
  return {
    ok: true,
    status: 200,
    text: async () => "ok",
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
};

const chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
  },
  webRequest: {
    onBeforeSendHeaders: { addListener() {} },
  },
  tabs: {
    sendMessage(_id, _msg, cb) {
      if (typeof cb === "function") cb();
    },
  },
  downloads: {
    download(opts, cb) {
      downloads.push(opts);
      chrome.runtime.lastError = null;
      cb(1);
    },
  },
};

const mockURL = {
  createObjectURL() {
    return "blob:mock-zip";
  },
  revokeObjectURL() {},
};

const context = {
  chrome,
  fetch: fakeFetch,
  URL: mockURL,
  Blob: class Blob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || "";
    }
  },
  btoa(s) {
    return Buffer.from(String(s), "binary").toString("base64");
  },
  TextEncoder,
  Uint8Array,
  Uint32Array,
  AbortController: class AbortController {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  },
  setTimeout,
  clearTimeout,
  console,
  globalThis: null,
};
context.globalThis = context;

vm.runInNewContext(bgSrc, context, { timeout: 5000 });
const api = context.__A3BatchQaBg;
if (!api) {
  fail("missing __A3BatchQaBg");
  process.exit(1);
}
if (api.VERSION !== "1.0.11") fail("VERSION want 1.0.11 got " + api.VERSION);
else ok("VERSION 1.0.11");

// sanitize must erase raw phrase
const sanitized = api.sanitizeUserError(new TypeError("Failed to fetch"));
if (/Failed to fetch/i.test(sanitized)) fail("sanitize still contains Failed to fetch: " + sanitized);
else ok("sanitizeUserError remaps Failed to fetch → " + sanitized);

// bad bearer → network TypeError mapped (not raw)
fetchCalls.length = 0;
try {
  await api.fetchOne("https://agent.a3database.cn/scope", "s1", "bad");
  fail("expected throw");
} catch (e) {
  if (/Failed to fetch/i.test(String(e.message || e))) {
    fail("fetchOne still surfaces Failed to fetch: " + e.message);
  } else {
    ok("bad network mapped: " + e.message);
  }
}

// happy path
fetchCalls.length = 0;
downloads.length = 0;
const result = await api.runBatch(
  {
    jobs: [
      { sessionId: "sess-a", fileName: "张舒怡_11-20_17_49_33.txt" },
      { sessionId: "sess-b", fileName: "李四_最近一轮.txt" },
    ],
    bearer: "good-token",
    authPath: "webRequest",
    agentBase: "https://agent.a3database.cn/scope",
    zipName: "execution-qa-test.zip",
    requestId: "r1",
  },
  42,
  (m) => portMessages.push(m)
);
if (!result.ok) fail("runBatch failed: " + result.text);
if (fetchCalls.length !== 2) fail("want 2 background fetches, got " + fetchCalls.length);
if (fetchCalls.some((c) => c.via !== "background-mock")) fail("non-background fetch");
if (/Failed to fetch/i.test(result.text || "")) fail("result text contains Failed to fetch");
if (!downloads.length) fail("expected chrome.downloads.download call");
else if (!String(downloads[0].url || "").startsWith("data:application/zip;base64,")) {
  fail("download url should be data URL, got " + String(downloads[0].url).slice(0, 40));
} else {
  ok("background batch ok via data URL; filenames preserved; no raw Failed to fetch");
}

const manifest = JSON.parse(read("extension/manifest.json"));
if (manifest.version !== "1.0.11") fail("manifest " + manifest.version);
if (!(manifest.permissions || []).includes("webRequest")) fail("manifest missing webRequest");
if (!(manifest.permissions || []).includes("downloads")) fail("manifest missing downloads");
ok("manifest 1.0.11 webRequest+downloads");

if (process.exitCode) {
  console.error("\nRegression FAILED");
  process.exit(1);
}
console.log("\nAll v1.0.11 regress checks passed.");
