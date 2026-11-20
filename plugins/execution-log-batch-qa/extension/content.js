/**
 * A3 Agent Center — execution-log batch 「下载问答」 core.
 *
 * Discovered from production bundles (a3-lib.a3database.cn):
 *   GET {agentBase}/admin/conversations/{sessionId}/download?variant=brief
 *   agentBase = https://agent.a3database.cn/scope  (prod host map)
 *   Auth: Authorization: Bearer <AUTO token>
 *   AUTO token: GET {apiBase}/api/v1/sys/user-tokens/me/auto  (cookie session)
 *   Filename: Content-Disposition, else execution-{sessionId}-brief.txt
 *
 * No secrets are stored; token is read from the live page session only.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.A3ExecLogBatchQa = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VARIANT = "brief";
  var HOST_AGENT = {
    "a3-lib.a3database.cn": "https://agent.a3database.cn",
    "a3-pre-lib.a3database.cn": "https://agent.a3database.cn",
    "a3-test-lib.a3database.cn": "https://agent-test.a3database.cn",
  };
  var HOST_API = {
    "a3-lib.a3database.cn": "https://api.a3database.cn",
    "a3-pre-lib.a3database.cn": "https://pre-api.a3database.cn",
    "a3-test-lib.a3database.cn": "https://test-api.a3database.cn",
  };

  var capturedBearer = "";
  var uiInstalled = false;
  var selected = Object.create(null);
  var busy = false;

  function agentBase() {
    var host = location.hostname;
    var origin = HOST_AGENT[host] || "https://agent.a3database.cn";
    return origin.replace(/\/+$/, "") + "/scope";
  }

  function apiBase() {
    var host = location.hostname;
    return (HOST_API[host] || "https://api.a3database.cn").replace(/\/+$/, "");
  }

  function isExecLogPage() {
    return /\/ai\/agent-center\/execution-log\/?$/.test(location.pathname);
  }

  function isListView() {
    if (!isExecLogPage()) return false;
    var params = new URLSearchParams(location.search);
    return !params.get("sessionId");
  }

  function parseFilenameFromDisposition(header) {
    if (!header) return null;
    var star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
    if (star && star[1]) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"(.*)"$/, "$1"));
      } catch (e) {
        return star[1].trim();
      }
    }
    var quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
    if (quoted && quoted[1]) return quoted[1];
    var plain = /filename\s*=\s*([^;]+)/i.exec(header);
    if (plain && plain[1]) return plain[1].trim().replace(/^"(.*)"$/, "$1");
    return null;
  }

  function fallbackFilename(sessionId, variant) {
    var u = "";
    var f = String(sessionId || "").trim();
    for (var i = 0; i < f.length && u.length < 80; i++) {
      var ch = f[i];
      u += /[A-Za-z0-9_-]/.test(ch) ? ch : "_";
    }
    return "execution-" + (u || "conversation") + "-" + (variant || VARIANT) + ".txt";
  }

  function zipStamp() {
    var d = new Date();
    function p(n) {
      return String(n).padStart(2, "0");
    }
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    );
  }

  /* ---- minimal ZIP (STORE, no compression) ---- */
  function crcTable() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }
  var CRC_TABLE = crcTable();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(n) {
    return [n & 0xff, (n >>> 8) & 0xff];
  }
  function u32(n) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }
  function concatBytes(parts) {
    var len = 0;
    for (var i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    var o = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], o);
      o += parts[j].length;
    }
    return out;
  }

  function encodeUtf8(str) {
    return new TextEncoder().encode(str);
  }

  function buildZip(entries) {
    // entries: [{name, data:Uint8Array}]
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var now = new Date();
    var dosTime =
      ((now.getHours() & 0x1f) << 11) |
      ((now.getMinutes() & 0x3f) << 5) |
      ((Math.floor(now.getSeconds() / 2) & 0x1f) << 0);
    var dosDate =
      (((now.getFullYear() - 1980) & 0x7f) << 9) |
      (((now.getMonth() + 1) & 0xf) << 5) |
      (now.getDate() & 0x1f);

    for (var i = 0; i < entries.length; i++) {
      var nameBytes = encodeUtf8(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var localHeader = concatBytes([
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(0x0800)), // UTF-8 flag
        new Uint8Array(u16(0)), // store
        new Uint8Array(u16(dosTime)),
        new Uint8Array(u16(dosDate)),
        new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u16(nameBytes.length)),
        new Uint8Array(u16(0)),
        nameBytes,
      ]);
      localParts.push(localHeader, data);

      var central = concatBytes([
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(20)),
        new Uint8Array(u16(0x0800)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(dosTime)),
        new Uint8Array(u16(dosDate)),
        new Uint8Array(u32(crc)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u32(data.length)),
        new Uint8Array(u16(nameBytes.length)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u16(0)),
        new Uint8Array(u32(0)),
        new Uint8Array(u32(offset)),
        nameBytes,
      ]);
      centralParts.push(central);
      offset += localHeader.length + data.length;
    }

    var centralDir = concatBytes(centralParts);
    var end = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(entries.length)),
      new Uint8Array(u16(entries.length)),
      new Uint8Array(u32(centralDir.length)),
      new Uint8Array(u32(offset)),
      new Uint8Array(u16(0)),
    ]);
    return concatBytes(localParts.concat([centralDir, end]));
  }

  /* ---- auth ---- */
  function rememberBearer(value) {
    if (!value) return;
    var m = String(value).match(/^\s*Bearer\s+(.+)\s*$/i);
    capturedBearer = (m ? m[1] : value).trim();
  }

  function installAuthCapture() {
    if (root.__a3BatchQaFetchHooked) return;
    root.__a3BatchQaFetchHooked = true;
    var origFetch = root.fetch;
    if (typeof origFetch !== "function") return;
    root.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : input && input.url;
        var headers = (init && init.headers) || (input && input.headers);
        if (url && /agent(-test)?\.a3database\.cn/.test(String(url))) {
          var auth = null;
          if (headers) {
            if (typeof headers.get === "function") auth = headers.get("Authorization") || headers.get("authorization");
            else if (headers.Authorization || headers.authorization) auth = headers.Authorization || headers.authorization;
          }
          if (auth) rememberBearer(auth);
        }
      } catch (e) {
        /* ignore */
      }
      return origFetch.apply(this, arguments);
    };
  }

  function readLoginToken() {
    try {
      // Same key as A3 lib request interceptor: localStorage["token"]
      return (window.localStorage && window.localStorage.getItem("token")) || "";
    } catch (e) {
      return "";
    }
  }

  function extractAutoToken(json) {
    if (!json || typeof json !== "object") return "";
    // Common shapes: { code:200, data:{ token } } or alova-unwrapped { data:{ token } } / { token }
    if (json.data && typeof json.data === "object" && json.data.token) return String(json.data.token);
    if (json.token) return String(json.token);
    return "";
  }

  async function fetchAutoToken() {
    var loginToken = readLoginToken();
    var headers = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    if (loginToken) headers.Authorization = "Bearer " + loginToken;
    var res = await fetch(apiBase() + "/api/v1/sys/user-tokens/me/auto", {
      method: "GET",
      credentials: "include",
      headers: headers,
    });
    var json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    // API may return HTTP 200 with { code:401, ... }
    var bizCode = json && json.code;
    if (!res.ok || (bizCode != null && bizCode !== 200 && !extractAutoToken(json))) {
      throw new Error(
        "获取 AUTO Token 失败（HTTP " +
          res.status +
          (bizCode != null ? ", code=" + bizCode : "") +
          "），请确认已登录且「我的令牌」可用"
      );
    }
    var token = extractAutoToken(json);
    if (!token) throw new Error("未能获取 AUTO Token，请前往「我的令牌」更新");
    rememberBearer(token);
    return token;
  }

  async function ensureBearer() {
    if (capturedBearer) return capturedBearer;
    return fetchAutoToken();
  }

  async function downloadBrief(sessionId) {
    var token = await ensureBearer();
    var url =
      agentBase() +
      "/admin/conversations/" +
      encodeURIComponent(sessionId) +
      "/download?variant=" +
      encodeURIComponent(VARIANT);
    var res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "*/*",
        Authorization: "Bearer " + token,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (res.status === 401) {
      capturedBearer = "";
      token = await fetchAutoToken();
      res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "*/*",
          Authorization: "Bearer " + token,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
    }
    if (!res.ok) {
      var detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch (e) {
        /* ignore */
      }
      throw new Error("下载失败 " + sessionId + " (HTTP " + res.status + ")" + (detail ? ": " + detail : ""));
    }
    var buf = new Uint8Array(await res.arrayBuffer());
    var name =
      parseFilenameFromDisposition(res.headers.get("content-disposition")) ||
      fallbackFilename(sessionId, VARIANT);
    return { name: name, data: buf, sessionId: sessionId };
  }

  function uniqueZipNames(files) {
    var used = Object.create(null);
    return files.map(function (f) {
      var base = f.name || f.sessionId + ".txt";
      var name = base;
      var n = 1;
      while (used[name]) {
        var dot = base.lastIndexOf(".");
        name = dot > 0 ? base.slice(0, dot) + "-" + n + base.slice(dot) : base + "-" + n;
        n++;
      }
      used[name] = true;
      return { name: name, data: f.data };
    });
  }

  function triggerDownload(bytes, filename) {
    var blob = new Blob([bytes], { type: "application/zip" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /* ---- UI ---- */
  function css() {
    return [
      ".a3-batch-qa-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;",
      "margin:0 0 12px;padding:10px 12px;border:1px solid #d9d9d9;border-radius:6px;",
      "background:#fafafa;font-size:13px;color:#262626}",
      ".a3-batch-qa-bar button{appearance:none;border:1px solid #1677ff;background:#1677ff;color:#fff;",
      "border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px;line-height:1.5}",
      ".a3-batch-qa-bar button[disabled]{opacity:.55;cursor:not-allowed}",
      ".a3-batch-qa-bar button.a3-batch-qa-secondary{background:#fff;color:#1677ff}",
      ".a3-batch-qa-bar .a3-batch-qa-status{color:#595959}",
      ".a3-batch-qa-bar .a3-batch-qa-error{color:#cf1322}",
      ".a3-batch-qa-check{display:inline-flex;align-items:center;justify-content:center;",
      "width:18px;margin-right:6px;vertical-align:middle}",
      ".a3-batch-qa-check input{width:14px;height:14px;cursor:pointer}",
      "th.a3-batch-qa-th{width:42px !important;padding-left:8px !important;padding-right:0 !important}",
      "td.a3-batch-qa-td{width:42px !important;padding-left:8px !important;padding-right:0 !important}",
    ].join("");
  }

  function ensureStyles() {
    if (document.getElementById("a3-batch-qa-style")) return;
    var style = document.createElement("style");
    style.id = "a3-batch-qa-style";
    style.textContent = css();
    document.documentElement.appendChild(style);
  }

  function setStatus(text, isError) {
    var el = document.getElementById("a3-batch-qa-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "a3-batch-qa-status" + (isError ? " a3-batch-qa-error" : "");
  }

  function selectedIds() {
    return Object.keys(selected).filter(function (k) {
      return selected[k];
    });
  }

  function updateCount() {
    var btn = document.getElementById("a3-batch-qa-download");
    var n = selectedIds().length;
    if (btn) {
      btn.textContent = n ? "批量下载问答（" + n + "）" : "批量下载问答";
      btn.disabled = busy || n === 0;
    }
  }

  function onToggle(sessionId, checked) {
    if (checked) selected[sessionId] = true;
    else delete selected[sessionId];
    updateCount();
  }

  function findTable() {
    return document.querySelector(".exec-log__table table") || document.querySelector(".exec-log table");
  }

  function injectHeaderCheckbox(table) {
    var thead = table.querySelector("thead tr");
    if (!thead || thead.querySelector(".a3-batch-qa-th")) return;
    var th = document.createElement("th");
    th.className = "a3-batch-qa-th ant-table-cell";
    th.innerHTML =
      '<label class="a3-batch-qa-check" title="全选本页"><input type="checkbox" id="a3-batch-qa-all" /></label>';
    thead.insertBefore(th, thead.firstChild);
    th.querySelector("input").addEventListener("click", function (e) {
      e.stopPropagation();
    });
    th.querySelector("input").addEventListener("change", function (e) {
      var checked = e.target.checked;
      table.querySelectorAll("tbody tr[data-row-key]").forEach(function (tr) {
        var id = tr.getAttribute("data-row-key");
        var box = tr.querySelector(".a3-batch-qa-row-check");
        if (box) box.checked = checked;
        onToggle(id, checked);
      });
    });
  }

  function injectRowCheckboxes(table) {
    table.querySelectorAll("tbody tr[data-row-key]").forEach(function (tr) {
      if (tr.querySelector(".a3-batch-qa-td")) {
        var existing = tr.querySelector(".a3-batch-qa-row-check");
        var id = tr.getAttribute("data-row-key");
        if (existing) existing.checked = !!selected[id];
        return;
      }
      var id = tr.getAttribute("data-row-key");
      if (!id) return;
      var td = document.createElement("td");
      td.className = "a3-batch-qa-td ant-table-cell";
      td.innerHTML =
        '<label class="a3-batch-qa-check"><input type="checkbox" class="a3-batch-qa-row-check" /></label>';
      var input = td.querySelector("input");
      input.checked = !!selected[id];
      input.addEventListener("click", function (e) {
        e.stopPropagation();
      });
      input.addEventListener("change", function (e) {
        e.stopPropagation();
        onToggle(id, e.target.checked);
      });
      tr.insertBefore(td, tr.firstChild);
    });
  }

  async function runBatch() {
    var ids = selectedIds();
    if (!ids.length || busy) return;
    busy = true;
    updateCount();
    setStatus("准备下载 " + ids.length + " 个会话…");
    var files = [];
    var errors = [];
    try {
      await ensureBearer();
      for (var i = 0; i < ids.length; i++) {
        var sid = ids[i];
        setStatus("下载中 " + (i + 1) + "/" + ids.length + " …");
        try {
          files.push(await downloadBrief(sid));
        } catch (err) {
          errors.push(String(err && err.message ? err.message : err));
        }
      }
      if (!files.length) throw new Error(errors[0] || "全部下载失败");
      var zipName = "execution-qa-" + zipStamp() + ".zip";
      var zipBytes = buildZip(uniqueZipNames(files));
      triggerDownload(zipBytes, zipName);
      setStatus(
        "已打包 " +
          files.length +
          " 个 txt → " +
          zipName +
          (errors.length ? "；失败 " + errors.length + " 个" : "")
      );
      if (errors.length) console.warn("[a3-batch-qa]", errors);
    } catch (err) {
      setStatus(String(err && err.message ? err.message : err), true);
      console.error("[a3-batch-qa]", err);
    } finally {
      busy = false;
      updateCount();
    }
  }

  function ensureToolbar(anchor) {
    if (document.getElementById("a3-batch-qa-bar")) return;
    var bar = document.createElement("div");
    bar.id = "a3-batch-qa-bar";
    bar.className = "a3-batch-qa-bar";
    bar.innerHTML = [
      '<strong>批量下载问答</strong>',
      '<button type="button" class="a3-batch-qa-secondary" id="a3-batch-qa-clear">清空选择</button>',
      '<button type="button" id="a3-batch-qa-download" disabled>批量下载问答</button>',
      '<span id="a3-batch-qa-status" class="a3-batch-qa-status">勾选行后打包为 ZIP（variant=brief，与「下载问答」相同）</span>',
    ].join("");
    anchor.parentNode.insertBefore(bar, anchor);
    document.getElementById("a3-batch-qa-clear").addEventListener("click", function () {
      selected = Object.create(null);
      document.querySelectorAll(".a3-batch-qa-row-check, #a3-batch-qa-all").forEach(function (el) {
        el.checked = false;
      });
      updateCount();
      setStatus("已清空选择");
    });
    document.getElementById("a3-batch-qa-download").addEventListener("click", function () {
      runBatch();
    });
  }

  function syncUi() {
    if (!isListView()) {
      var bar = document.getElementById("a3-batch-qa-bar");
      if (bar) bar.style.display = "none";
      return;
    }
    ensureStyles();
    var tableWrap = document.querySelector(".exec-log__table");
    if (!tableWrap) return;
    ensureToolbar(tableWrap);
    var bar = document.getElementById("a3-batch-qa-bar");
    if (bar) bar.style.display = "";
    var table = findTable();
    if (!table) return;
    injectHeaderCheckbox(table);
    injectRowCheckboxes(table);
    updateCount();
  }

  function start() {
    installAuthCapture();
    if (uiInstalled) return;
    uiInstalled = true;
    syncUi();
    var obs = new MutationObserver(function () {
      syncUi();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    root.addEventListener("popstate", syncUi);
    var _push = history.pushState;
    var _replace = history.replaceState;
    history.pushState = function () {
      var r = _push.apply(this, arguments);
      setTimeout(syncUi, 0);
      return r;
    };
    history.replaceState = function () {
      var r = _replace.apply(this, arguments);
      setTimeout(syncUi, 0);
      return r;
    };
  }

  return {
    start: start,
    agentBase: agentBase,
    apiBase: apiBase,
    downloadBrief: downloadBrief,
    VARIANT: VARIANT,
  };
});

(function () {
  if (window.A3ExecLogBatchQa) window.A3ExecLogBatchQa.start();
})();
