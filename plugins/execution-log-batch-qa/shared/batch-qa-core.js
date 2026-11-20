/**
 * A3 Agent Center — execution-log batch 「下载问答」 core (v1.0.2+).
 *
 * Safety rules (do NOT break page load):
 * - Never monkeypatch window.fetch / history.pushState / replaceState
 * - Never MutationObserver on document (races React)
 * - Never inject <td>/<th> into Ant Design Table (corrupts React tree → skeleton forever)
 * - Soft-poll for tr[data-row-key]; UI lives on document.body only
 * - All entry points wrapped in try/catch
 *
 * API (from production bundles):
 *   GET {agentBase}/admin/conversations/{sessionId}/download?variant=brief
 *   Auth: Bearer AUTO token via localStorage.token → /api/v1/sys/user-tokens/me/auto
 */
(function (root, factory) {
  try {
    var api = factory();
    if (typeof module === "object" && module.exports) {
      module.exports = api;
    }
    root.A3ExecLogBatchQa = api;
  } catch (err) {
    try {
      console.error("[a3-batch-qa] init failed", err);
    } catch (e) {
      /* ignore */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "1.0.2";
  var VARIANT = "brief";
  var POLL_MS = 1500;
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

  var selected = Object.create(null);
  var busy = false;
  var started = false;
  var pollTimer = null;
  var lastPath = "";

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
    try {
      return /\/ai\/agent-center\/execution-log\/?$/.test(location.pathname);
    } catch (e) {
      return false;
    }
  }

  function isListView() {
    try {
      if (!isExecLogPage()) return false;
      return !new URLSearchParams(location.search).get("sessionId");
    } catch (e) {
      return false;
    }
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

  /* ---- minimal ZIP (STORE) ---- */
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
        new Uint8Array(u16(0x0800)),
        new Uint8Array(u16(0)),
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

  /* ---- auth (no fetch monkeypatch) ---- */
  var capturedBearer = "";

  function rememberBearer(value) {
    if (!value) return;
    var m = String(value).match(/^\s*Bearer\s+(.+)\s*$/i);
    capturedBearer = (m ? m[1] : value).trim();
  }

  function readLoginToken() {
    try {
      return (root.localStorage && root.localStorage.getItem("token")) || "";
    } catch (e) {
      return "";
    }
  }

  function extractAutoToken(json) {
    if (!json || typeof json !== "object") return "";
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
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    }, 2000);
  }

  /* ---- DOM helpers (read-only on page table) ---- */
  function readPageSessionIds() {
    var ids = [];
    var seen = Object.create(null);
    try {
      var nodes = document.querySelectorAll("tr[data-row-key]");
      for (var i = 0; i < nodes.length; i++) {
        var id = nodes[i].getAttribute("data-row-key");
        if (!id || seen[id]) continue;
        // skip placeholder / empty keys
        if (id === "null" || id === "undefined") continue;
        seen[id] = true;
        ids.push(id);
      }
    } catch (e) {
      /* ignore */
    }
    return ids;
  }

  function pageHasLoadedRows() {
    return readPageSessionIds().length > 0;
  }

  /* ---- UI (body-mounted only; never touch Ant table cells) ---- */
  function css() {
    return [
      "#a3-batch-qa-root{all:initial;position:fixed;z-index:2147483000;right:16px;bottom:16px;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "font-size:13px;line-height:1.4;color:#262626}",
      "#a3-batch-qa-root *{box-sizing:border-box;font-family:inherit}",
      "#a3-batch-qa-panel{width:320px;max-height:min(70vh,520px);display:flex;flex-direction:column;",
      "background:#fff;border:1px solid #d9d9d9;border-radius:8px;",
      "box-shadow:0 6px 24px rgba(0,0,0,.12);overflow:hidden}",
      "#a3-batch-qa-panel header{display:flex;align-items:center;justify-content:space-between;",
      "padding:10px 12px;border-bottom:1px solid #f0f0f0;background:#fafafa}",
      "#a3-batch-qa-panel header strong{font-size:13px}",
      "#a3-batch-qa-panel .a3-batch-qa-actions{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;",
      "border-bottom:1px solid #f0f0f0}",
      "#a3-batch-qa-panel button{appearance:none;border:1px solid #1677ff;background:#1677ff;color:#fff;",
      "border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px}",
      "#a3-batch-qa-panel button[disabled]{opacity:.55;cursor:not-allowed}",
      "#a3-batch-qa-panel button.secondary{background:#fff;color:#1677ff}",
      "#a3-batch-qa-list{overflow:auto;padding:8px 12px;flex:1;min-height:80px}",
      "#a3-batch-qa-list label{display:flex;align-items:flex-start;gap:8px;padding:4px 0;",
      "cursor:pointer;word-break:break-all}",
      "#a3-batch-qa-list input{margin-top:2px;flex:none}",
      "#a3-batch-qa-status{padding:8px 12px;border-top:1px solid #f0f0f0;color:#595959;font-size:12px}",
      "#a3-batch-qa-status.is-error{color:#cf1322}",
      "#a3-batch-qa-toggle{margin-top:8px;width:100%;border:1px solid #d9d9d9;background:#fff;color:#262626;",
      "border-radius:8px;padding:8px 10px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.1)}",
      "#a3-batch-qa-empty{color:#8c8c8c;padding:12px 0}",
    ].join("");
  }

  function ensureStyles() {
    if (document.getElementById("a3-batch-qa-style")) return;
    var style = document.createElement("style");
    style.id = "a3-batch-qa-style";
    style.textContent = css();
    (document.head || document.documentElement).appendChild(style);
  }

  function setStatus(text, isError) {
    var el = document.getElementById("a3-batch-qa-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = isError ? "is-error" : "";
  }

  function selectedIds() {
    return Object.keys(selected).filter(function (k) {
      return selected[k];
    });
  }

  function updateDownloadButton() {
    var btn = document.getElementById("a3-batch-qa-download");
    if (!btn) return;
    var n = selectedIds().length;
    btn.textContent = n ? "批量下载问答（" + n + "）" : "批量下载问答";
    btn.disabled = busy || n === 0;
  }

  function onToggle(sessionId, checked) {
    if (checked) selected[sessionId] = true;
    else delete selected[sessionId];
    updateDownloadButton();
  }

  function renderSessionList(ids) {
    var list = document.getElementById("a3-batch-qa-list");
    if (!list) return;
    list.innerHTML = "";
    if (!ids.length) {
      list.innerHTML = '<div id="a3-batch-qa-empty">等待列表加载…（出现会话行后可勾选）</div>';
      return;
    }
    ids.forEach(function (id) {
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!selected[id];
      input.addEventListener("change", function () {
        onToggle(id, input.checked);
      });
      var span = document.createElement("span");
      span.textContent = id.length > 28 ? id.slice(0, 12) + "…" + id.slice(-8) : id;
      span.title = id;
      label.appendChild(input);
      label.appendChild(span);
      list.appendChild(label);
    });
  }

  function ensurePanel() {
    if (document.getElementById("a3-batch-qa-root")) return;
    ensureStyles();
    var rootEl = document.createElement("div");
    rootEl.id = "a3-batch-qa-root";
    rootEl.innerHTML = [
      '<div id="a3-batch-qa-panel">',
      "  <header><strong>批量下载问答</strong><span style=\"color:#8c8c8c;font-size:11px\">v" +
        VERSION +
        "</span></header>",
      '  <div class="a3-batch-qa-actions">',
      '    <button type="button" class="secondary" id="a3-batch-qa-select-page">全选本页</button>',
      '    <button type="button" class="secondary" id="a3-batch-qa-clear">清空</button>',
      '    <button type="button" id="a3-batch-qa-download" disabled>批量下载问答</button>',
      "  </div>",
      '  <div id="a3-batch-qa-list"></div>',
      '  <div id="a3-batch-qa-status">勾选后打包 ZIP（与「下载问答」相同 brief）</div>',
      "</div>",
      '<button type="button" id="a3-batch-qa-toggle">收起批量下载</button>',
    ].join("");
    document.body.appendChild(rootEl);

    document.getElementById("a3-batch-qa-select-page").addEventListener("click", function () {
      try {
        readPageSessionIds().forEach(function (id) {
          selected[id] = true;
        });
        tick();
      } catch (e) {
        setStatus(String(e && e.message ? e.message : e), true);
      }
    });
    document.getElementById("a3-batch-qa-clear").addEventListener("click", function () {
      selected = Object.create(null);
      tick();
      setStatus("已清空选择");
    });
    document.getElementById("a3-batch-qa-download").addEventListener("click", function () {
      runBatch().catch(function (err) {
        setStatus(String(err && err.message ? err.message : err), true);
      });
    });
    document.getElementById("a3-batch-qa-toggle").addEventListener("click", function () {
      var panel = document.getElementById("a3-batch-qa-panel");
      var btn = document.getElementById("a3-batch-qa-toggle");
      if (!panel || !btn) return;
      var hide = panel.style.display !== "none";
      panel.style.display = hide ? "none" : "";
      btn.textContent = hide ? "展开批量下载问答" : "收起批量下载";
    });
  }

  function hidePanel() {
    var rootEl = document.getElementById("a3-batch-qa-root");
    if (rootEl) rootEl.style.display = "none";
  }

  function showPanel() {
    var rootEl = document.getElementById("a3-batch-qa-root");
    if (rootEl) rootEl.style.display = "";
  }

  async function runBatch() {
    var ids = selectedIds();
    if (!ids.length || busy) return;
    busy = true;
    updateDownloadButton();
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
      updateDownloadButton();
    }
  }

  function tick() {
    try {
      var pathKey = location.pathname + location.search;
      if (pathKey !== lastPath) {
        lastPath = pathKey;
        // drop stale selections when leaving list
        if (!isListView()) selected = Object.create(null);
      }

      if (!isListView()) {
        hidePanel();
        return;
      }

      // Defer UI until React has painted real rows — never mutate early
      if (!pageHasLoadedRows()) {
        // still show a collapsed hint only after exec-log shell exists
        var shell =
          document.querySelector(".exec-log") ||
          document.querySelector(".ai-page-board") ||
          document.querySelector(".exec-log__table");
        if (!shell) {
          hidePanel();
          return;
        }
        ensurePanel();
        showPanel();
        renderSessionList([]);
        updateDownloadButton();
        setStatus("列表加载中…加载出会话行后再勾选");
        return;
      }

      ensurePanel();
      showPanel();
      renderSessionList(readPageSessionIds());
      updateDownloadButton();
    } catch (err) {
      try {
        console.error("[a3-batch-qa] tick", err);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function start() {
    try {
      if (started) return;
      started = true;
      // Soft polling only — no history rewrite, no MutationObserver, no fetch patch
      tick();
      pollTimer = setInterval(tick, POLL_MS);
      try {
        console.info("[a3-batch-qa] started v" + VERSION + " (safe mode)");
      } catch (e) {
        /* ignore */
      }
    } catch (err) {
      try {
        console.error("[a3-batch-qa] start failed", err);
      } catch (e) {
        /* ignore */
      }
    }
  }

  return {
    start: start,
    agentBase: agentBase,
    apiBase: apiBase,
    downloadBrief: downloadBrief,
    VARIANT: VARIANT,
    VERSION: VERSION,
  };
});
