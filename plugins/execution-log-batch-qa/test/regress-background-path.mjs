#!/usr/bin/env node
/**
 * Minimal regress: prove Agent downloads go through mocked background fetch,
 * and page/content sources never construct+fetch Agent download URLs.
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

// ---- 1) Static: content / core / bridge must not page-fetch Agent downloads ----
const pageSources = [
  "shared/batch-qa-core.js",
  "extension/content.js",
  "extension/page-bridge.js",
];

for (const rel of pageSources) {
  const src = read(rel);
  if (/\/admin\/conversations\/.\{0,40\}download/.test(src) && /fetch\s*\(/.test(src)) {
    // page-bridge may mention CORS in comments; forbid actual downloadUrl builders
    if (/function\s+downloadUrl|download\?variant/.test(src) && !rel.includes("background")) {
      fail(`${rel} looks like it builds Agent download URLs (should be background-only)`);
    }
  }
  // content/core must never call fetch() at all for agent (allow zero fetch in core for extension path)
  if (rel.includes("batch-qa-core") || rel.includes("content.js")) {
    const fetchCalls = [...src.matchAll(/\bfetch\s*\(/g)];
    if (fetchCalls.length > 0) {
      fail(`${rel} contains fetch( — page/content must not fetch Agent`);
    } else {
      ok(`${rel}: no fetch()`);
    }
  }
  if (rel.includes("page-bridge")) {
    if (/downloadUrl\s*\(/.test(src) || /\/download\?variant/.test(src)) {
      fail(`${rel} must not call Agent download endpoints`);
    } else {
      ok(`${rel}: observe-only (no Agent download URL)`);
    }
    if (!/Does NOT download Agent|downloadVia:\s*"background"/.test(src)) {
      fail(`${rel} missing background-download contract comment/flag`);
    }
  }
}

// ---- 2) Dynamic: mock chrome + fetch; run background batch ----
const bgSrc = read("extension/background.js");
const fetchCalls = [];
const downloads = [];
const portMessages = [];

const fakeFetch = async (url, init) => {
  fetchCalls.push({
    url: String(url),
    auth: (init && init.headers && init.headers.Authorization) || "",
    via: "background-mock",
  });
  if (!init || !init.headers || !String(init.headers.Authorization || "").includes("Bearer ")) {
    return {
      ok: false,
      status: 401,
      text: async () => '{"code":"AUTH_INVALID"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (String(url).includes("bad-session")) {
    return {
      ok: false,
      status: 404,
      text: async () => "missing",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  const body = new TextEncoder().encode("Q: hi\nA: hello\n");
  return {
    ok: true,
    status: 200,
    text: async () => "Q: hi\nA: hello\n",
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
};

const chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
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
  createObjectURL(blob) {
    if (!blob) throw new Error("createObjectURL missing blob");
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
if (!api || !api.runBatch) {
  fail("background did not export __A3BatchQaBg.runBatch");
  process.exit(1);
}
ok(`background loaded VERSION=${api.VERSION}`);

if (api.VERSION !== "1.0.8") {
  fail(`expected VERSION 1.0.8, got ${api.VERSION}`);
}

// empty bearer must fail before fetch
fetchCalls.length = 0;
try {
  await api.runBatch(
    {
      jobs: [{ sessionId: "s1", fileName: "u_r.txt" }],
      bearer: "",
      agentBase: "https://agent.a3database.cn/scope",
      zipName: "t.zip",
      requestId: "r0",
    },
    1,
    (m) => portMessages.push(m)
  );
  fail("empty bearer should throw");
} catch (e) {
  if (!/Bearer/i.test(String(e.message || e))) fail("empty bearer error mislabeled: " + e);
  else ok("empty bearer rejected before fetch: " + e.message);
}
if (fetchCalls.length !== 0) fail("empty bearer must not call fetch");

// happy path: 2 jobs → background fetch only
fetchCalls.length = 0;
downloads.length = 0;
portMessages.length = 0;
const result = await api.runBatch(
  {
    jobs: [
      { sessionId: "sess-a", fileName: "张三_最近一轮.txt" },
      { sessionId: "sess-b", fileName: "李四_11-20.txt" },
    ],
    bearer: "auto-token-xyz",
    authPath: "page-fetch-observe",
    agentBase: "https://agent.a3database.cn/scope",
    zipName: "execution-qa-test.zip",
    requestId: "r1",
  },
  42,
  (m) => portMessages.push(m)
);

if (!result.ok) fail("runBatch should ok: " + result.text);
if (fetchCalls.length !== 2) fail("expected 2 background fetches, got " + fetchCalls.length);
for (const c of fetchCalls) {
  if (c.via !== "background-mock") fail("fetch not from background mock");
  if (!/agent\.a3database\.cn\/scope\/admin\/conversations\/sess-/.test(c.url)) {
    fail("unexpected url " + c.url);
  }
  if (!c.auth.includes("Bearer auto-token-xyz")) fail("missing Authorization on background fetch");
}
if (downloads.length !== 1) fail("expected 1 chrome.downloads.download, got " + downloads.length);
if (downloads[0].filename !== "execution-qa-test.zip") fail("zip name mismatch");
if (!portMessages.some((m) => m.type === "batch-status" && /后台下载/.test(m.text || ""))) {
  fail("missing background progress status");
}
ok("background fetched 2 files + zip via chrome.downloads (no page fetch)");

// zip helper smoke
const z = api.buildZip([{ name: "a.txt", data: new Uint8Array([1, 2, 3]) }]);
if (z[0] !== 0x50 || z[1] !== 0x4b) fail("zip magic missing");
ok("STORE zip builder ok (" + z.length + " bytes)");

// 401 labeling
fetchCalls.length = 0;
try {
  await api.fetchOne("https://agent.a3database.cn/scope", "x", "");
  fail("fetchOne empty bearer should throw");
} catch (e) {
  ok("fetchOne empty bearer: " + e.message);
}

const authFailFetch = async () => ({
  ok: false,
  status: 401,
  text: async () => "nope",
  arrayBuffer: async () => new ArrayBuffer(0),
});
context.fetch = authFailFetch;
try {
  await api.fetchOne("https://agent.a3database.cn/scope", "x", "bad");
  fail("401 should throw");
} catch (e) {
  if (!/鉴权无效/.test(String(e.message || e))) fail("401 mislabeled: " + e);
  else ok("401 labeled as 鉴权无效 (not Failed to fetch)");
}

// manifest / packaging checks
const manifest = JSON.parse(read("extension/manifest.json"));
if (manifest.version !== "1.0.8") fail("manifest version " + manifest.version);
if (!manifest.background || manifest.background.service_worker !== "background.js") {
  fail("manifest missing background service_worker");
}
if (!(manifest.permissions || []).includes("downloads")) fail("manifest missing downloads permission");
if (!(manifest.host_permissions || []).some((h) => h.includes("agent.a3database.cn"))) {
  fail("manifest missing agent host_permissions");
}
ok("manifest 1.0.8 background + downloads + agent host_permissions");

if (process.exitCode) {
  console.error("\nRegression FAILED");
  process.exit(1);
}
console.log("\nAll regress checks passed (pending live login GUI).");
