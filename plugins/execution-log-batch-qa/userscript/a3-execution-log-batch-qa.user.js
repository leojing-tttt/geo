// ==UserScript==
// @name         A3 执行记录 · 批量下载问答
// @namespace    https://github.com/leojing-tttt/geo
// @version      1.0.11
// @description  需 Chrome 扩展 1.0.11（background；手动批量；无自动导出）
// @author       geo plugin
// @match        https://a3-lib.a3database.cn/*
// @match        https://a3-pre-lib.a3database.cn/*
// @match        https://a3-test-lib.a3database.cn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";
  try {
/**
 * MAIN-world auth bridge (v1.0.11).
 * No page network API wrappers for Agent downloads. Only:
 *  - soft-observe XHR Authorization (alova may use XHR in some builds)
 *  - optional DOM click on 「下载问答」so background webRequest can capture Bearer
 * Downloads are exclusively MV3 background (host_permissions).
 */
(function () {
  "use strict";
  try {
    if (window.__a3BatchQaBridgeInstalled) return;
    window.__a3BatchQaBridgeInstalled = true;

    var SOURCE = "a3-batch-qa";
    var EVENT = "__a3_batch_qa";
    var VERSION = "1.0.11";
    var AUTH_MS = 12000;

    var agentBearer = "";
    var authPath = "";
    var handledIds = Object.create(null);
    var authBusy = false;

    function stripBearer(v) {
      if (!v) return "";
      var m = String(v).match(/^\s*Bearer\s+(.+)\s*$/i);
      return (m ? m[1] : String(v)).trim();
    }

    function rememberBearer(v, path) {
      var t = stripBearer(v);
      if (!t) return false;
      agentBearer = t;
      authPath = path || authPath || "captured";
      return true;
    }

    function isAgentUrl(url) {
      return url && /agent(-test)?\.a3database\.cn/i.test(String(url));
    }

    function newMsgId() {
      return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function emit(msg) {
      var payload = { source: SOURCE, version: VERSION, msgId: newMsgId() };
      for (var k in msg) if (Object.prototype.hasOwnProperty.call(msg, k)) payload[k] = msg[k];
      try {
        document.documentElement.dispatchEvent(
          new CustomEvent(EVENT, { detail: payload, bubbles: true })
        );
      } catch (e) {
        /* ignore */
      }
      try {
        window.postMessage(payload, location.origin);
      } catch (e2) {
        try {
          window.postMessage(payload, "*");
        } catch (e3) {
          /* ignore */
        }
      }
    }

    function status(text, isError) {
      emit({ type: "batch-status", text: text || "", error: !!isError });
    }

    function withTimeout(promise, ms, label) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new Error((label || "操作") + "超时（" + Math.round(ms / 1000) + "s）"));
        }, ms);
        promise.then(
          function (v) {
            if (done) return;
            done = true;
            clearTimeout(t);
            resolve(v);
          },
          function (err) {
            if (done) return;
            done = true;
            clearTimeout(t);
            reject(err);
          }
        );
      });
    }

    // XHR observe only — do not wrap window networking globals in this file
    try {
      var XO = XMLHttpRequest.prototype.open;
      var XS = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__a3Url = url;
        return XO.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
          if (String(k).toLowerCase() === "authorization" && isAgentUrl(this.__a3Url)) {
            rememberBearer(v, "page-xhr-observe");
          }
        } catch (e) {
          /* ignore */
        }
        return XS.apply(this, arguments);
      };
    } catch (e) {
      /* ignore */
    }

    function readLoginToken() {
      try {
        var keys = ["token", "access_token", "accessToken", "authToken"];
        for (var i = 0; i < keys.length; i++) {
          var v = localStorage.getItem(keys[i]);
          if (v && String(v).trim()) return stripBearer(v);
        }
      } catch (e) {
        /* ignore */
      }
      return "";
    }

    function findDownloadBriefButton(sessionId) {
      try {
        var rows = document.querySelectorAll("tr[data-row-key]");
        for (var i = 0; i < rows.length; i++) {
          var tr = rows[i];
          if (sessionId && tr.getAttribute("data-row-key") !== sessionId) continue;
          var root = tr.querySelector(".exec-log__downloads") || tr;
          var nodes = root.querySelectorAll("button, a, span");
          for (var j = 0; j < nodes.length; j++) {
            var t = (nodes[j].textContent || "").replace(/\s+/g, "");
            if (t.indexOf("下载问答") !== -1) return nodes[j];
          }
          if (sessionId) break;
        }
        var all = document.querySelectorAll(".exec-log__downloads button, .exec-log__downloads a");
        for (var k = 0; k < all.length; k++) {
          if ((all[k].textContent || "").indexOf("下载问答") !== -1) return all[k];
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    }

    /** Click page control so *page* issues Agent request; background webRequest captures Bearer. */
    function warmCaptureByClick(preferredSessionId) {
      return new Promise(function (resolve) {
        if (agentBearer) {
          resolve(true);
          return;
        }
        var btn = findDownloadBriefButton(preferredSessionId);
        if (!btn) {
          resolve(false);
          return;
        }
        var started = Date.now();
        try {
          btn.click();
        } catch (e) {
          resolve(false);
          return;
        }
        // Wait for XHR observe OR for background to have captured (content will poll bg)
        var timer = setInterval(function () {
          if (agentBearer || Date.now() - started > 5000) {
            clearInterval(timer);
            if (agentBearer) authPath = authPath || "warm-click-dom";
            resolve(!!agentBearer);
          }
        }, 50);
      });
    }

    async function ensureAgentBearer(preferredSessionId) {
      return withTimeout(
        (async function () {
          if (agentBearer) return agentBearer;
          status("鉴权中: 等待已截获的 Bearer（XHR / 扩展 webRequest）…");
          await new Promise(function (r) {
            setTimeout(r, 120);
          });
          if (agentBearer) return agentBearer;

          status("鉴权中: 点击页面「下载问答」以触发真实请求（本桥不下载）…");
          if (await warmCaptureByClick(preferredSessionId)) return agentBearer;

          await new Promise(function (r) {
            setTimeout(r, 600);
          });
          if (agentBearer) return agentBearer;

          var login = readLoginToken();
          if (login) {
            rememberBearer(login, "login-token-candidate");
            status("未截获 Agent Bearer，交登录 token 给后台验证…");
            return agentBearer;
          }

          throw new Error(
            "鉴权失败（未截获 Authorization）。请手动点一次「下载问答」后再批量。"
          );
        })(),
        AUTH_MS,
        "鉴权"
      );
    }

    function emitBearer(requestId, ok, errText) {
      emit({
        type: "bearer",
        requestId: requestId,
        ok: !!ok,
        bearer: ok ? agentBearer : "",
        authPath: authPath || "",
        hasAgentBearer: !!agentBearer,
        error: errText || "",
      });
    }

    function handleInbound(d) {
      if (!d || d.source !== SOURCE) return;
      if (d.msgId) {
        if (handledIds[d.msgId]) return;
        handledIds[d.msgId] = Date.now();
      }
      if (d.type === "batch-run") {
        emit({
          type: "batch-ack",
          requestId: d.requestId,
          action: "rejected-use-background",
          count: 0,
        });
        status("禁止页面下载：请使用扩展后台（重新加载 1.0.11 扩展）", true);
        emit({
          type: "batch-done",
          requestId: d.requestId,
          ok: false,
          text: "v1.0.11：页面侧禁止下载 Agent；请确认扩展后台已加载",
        });
        return;
      }
      if (d.type === "ping" || d.type === "request-auth") {
        emit({
          type: "auth",
          hasAgentBearer: !!agentBearer,
          authPath: authPath || "",
          hasLoginToken: !!readLoginToken(),
          bridge: true,
          version: VERSION,
          downloadVia: "background",
        });
        if (d.type === "ping") emit({ type: "pong", version: VERSION, requestId: d.requestId });
      } else if (d.type === "warm-auth" || d.type === "ensure-auth") {
        if (authBusy) {
          emitBearer(d.requestId, !!agentBearer, agentBearer ? "" : "鉴权进行中");
          return;
        }
        authBusy = true;
        emit({ type: "batch-ack", requestId: d.requestId, action: d.type });
        ensureAgentBearer(d.sessionId || "")
          .then(function () {
            status("鉴权候选就绪（" + (authPath || "captured") + "）→ 扩展后台下载");
            emitBearer(d.requestId, true);
          })
          .catch(function (err) {
            var t = String(err && err.message ? err.message : err);
            status(t, true);
            emitBearer(d.requestId, false, t);
          })
          .finally(function () {
            authBusy = false;
          });
      } else if (d.type === "get-bearer") {
        emitBearer(d.requestId, !!agentBearer, agentBearer ? "" : "尚无 Bearer");
      } else if (d.type === "inject-bearer" && d.bearer) {
        // background → content → bridge: optional sync of webRequest-captured token
        rememberBearer(d.bearer, d.authPath || "webRequest");
      }
    }

    document.documentElement.addEventListener(EVENT, function (ev) {
      try {
        handleInbound(ev.detail);
      } catch (e) {
        /* ignore */
      }
    });
    window.addEventListener("message", function (ev) {
      try {
        handleInbound(ev.data);
      } catch (e) {
        /* ignore */
      }
    });

    emit({ type: "bridge-ready", version: VERSION, downloadVia: "background", noPageFetch: true });
  } catch (err) {
    try {
      console.error("[a3-batch-qa-bridge]", err);
    } catch (e) {
      /* ignore */
    }
  }
})();

/**
 * A3 Agent Center — execution-log batch 「下载问答」 core (v1.0.11+).
 *
 * Safety rules (do NOT break page load):
 * - UI in ISOLATED: never MutationObserver / history rewrite / Ant Table cell injection
 * - Soft-poll for tr[data-row-key]; UI on document.body only
 * - ZERO page fetch to Agent; refuse batch if background ping fails
 * - Downloads via MV3 background Port; zip stays in background
 *
 * API (background only):
 *   GET {agentBase}/admin/conversations/{sessionId}/download?variant=brief
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

  var VERSION = "1.0.11";
  var VARIANT = "brief";
  var POLL_MS = 1500;
  var BRIDGE_ACK_MS = 2500;
  var AUTH_WAIT_MS = 14000;
  var BATCH_OVERALL_BASE_MS = 40000;
  var BATCH_OVERALL_PER_MS = 28000;
  var BATCH_OVERALL_CAP_MS = 12 * 60 * 1000;
  var BG_REQUIRED_MSG = "扩展后台未加载，请重新加载扩展";
  var hasExtensionRuntime =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    (typeof chrome.runtime.sendMessage === "function" || typeof chrome.runtime.connect === "function");
  var activePort = null;
  var bgAlive = false;
  var bgVersion = "";

  function sanitizeUiError(text) {
    var s = String(text == null ? "" : text);
    if (/Failed to fetch/i.test(s)) {
      return s.replace(/Failed to fetch/gi, "网络失败").replace(/TypeError:\s*/gi, "") +
        "（若仍失败请重新加载 1.0.11 扩展）";
    }
    return s;
  }
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

  function sanitizeFilenamePart(raw, maxLen) {
    var s = String(raw == null ? "" : raw).trim();
    // whitespace + filesystem-unsafe + path separators → _
    s = s.replace(/[\s\/\\?%*:|"<>\u0000-\u001f]+/g, "_");
    s = s.replace(/\.+$/g, ""); // trailing dots bad on Windows
    s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!s) s = "unknown";
    if (s.length > (maxLen || 80)) s = s.slice(0, maxLen || 80);
    return s;
  }

  function shortSessionSuffix(sessionId) {
    var id = String(sessionId || "").trim();
    if (!id) return "x";
    if (id.length <= 8) return id;
    return id.slice(0, 4) + id.slice(-4);
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

  /* ---- MAIN auth bridge + MV3 background downloads ---- */
  var BRIDGE_SOURCE = "a3-batch-qa";
  var BRIDGE_EVENT = "__a3_batch_qa";
  var lastAuthPath = "";
  var bridgeSeen = false;
  var bgSeen = false;
  var activeBatch = null; // { requestId, resolve, reject, ackTimer, doneTimer }
  var pendingBearer = null; // { requestId, resolve, reject, timer }
  var handledMsgIds = Object.create(null);

  function newMsgId() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function postToBridge(msg) {
    var payload = { source: BRIDGE_SOURCE, msgId: newMsgId() };
    for (var k in msg) if (Object.prototype.hasOwnProperty.call(msg, k)) payload[k] = msg[k];
    try {
      document.documentElement.dispatchEvent(
        new CustomEvent(BRIDGE_EVENT, { detail: payload, bubbles: true })
      );
    } catch (e) {
      /* ignore */
    }
    try {
      root.postMessage(payload, location.origin);
    } catch (e2) {
      try {
        root.postMessage(payload, "*");
      } catch (e3) {
        /* ignore */
      }
    }
  }

  function clearBusy(uiText, isError) {
    busy = false;
    try {
      updateDownloadButton();
    } catch (e) {
      /* ignore */
    }
    if (uiText != null) setStatus(sanitizeUiError(uiText), !!isError);
  }

  function finishActiveBatch(ok, text, data) {
    var ab = activeBatch;
    activeBatch = null;
    if (ab) {
      try {
        clearTimeout(ab.ackTimer);
      } catch (e) {
        /* ignore */
      }
      try {
        clearTimeout(ab.doneTimer);
      } catch (e) {
        /* ignore */
      }
    }
    var safe = sanitizeUiError(text || (ok ? "完成" : "失败"));
    clearBusy(safe, !ok);
    if (!ab) return;
    try {
      if (ok) ab.resolve(data || { ok: true, text: safe });
      else ab.reject(new Error(safe || "批量失败"));
    } catch (e) {
      /* ignore */
    }
  }

  function onBridgeMessage(d) {
    if (!d || d.source !== BRIDGE_SOURCE) return;
    if (d.msgId) {
      if (handledMsgIds[d.msgId]) return;
      handledMsgIds[d.msgId] = 1;
    }
    if (d.type === "bridge-ready" || d.type === "pong") {
      bridgeSeen = true;
      return;
    }
    if (d.type === "batch-status") {
      setStatus(d.text || "", !!d.error);
      return;
    }
    if (d.type === "batch-ack") {
      bridgeSeen = true;
      if (activeBatch && d.requestId && d.requestId === activeBatch.requestId) {
        try {
          clearTimeout(activeBatch.ackTimer);
        } catch (e) {
          /* ignore */
        }
        setStatus(
          "已确认（" +
            (d.count != null ? d.count + " 个" : d.action || "ok") +
            "），执行中…"
        );
      }
      return;
    }
    if (d.type === "auth") {
      bridgeSeen = true;
      lastAuthPath = d.authPath || lastAuthPath;
      if (d.ok === false) {
        setStatus("鉴权未就绪：请先手动点一次「下载问答」，或再点「同步鉴权」", true);
      } else if (d.hasAgentBearer) {
        setStatus("页面 Agent 鉴权已就绪（" + (d.authPath || "captured") + "）→ 后台下载");
      } else if (d.bridge) {
        setStatus(
          "桥接在线 v" +
            (d.version || "?") +
            "；下载走扩展后台（防 CORS）" +
            (d.hasAgentBearer ? "；已有 Bearer" : "")
        );
      }
      return;
    }
    if (d.type === "bearer") {
      if (pendingBearer && (!d.requestId || d.requestId === pendingBearer.requestId)) {
        var pb = pendingBearer;
        pendingBearer = null;
        try {
          clearTimeout(pb.timer);
        } catch (e) {
          /* ignore */
        }
        if (d.ok && d.bearer) {
          lastAuthPath = d.authPath || lastAuthPath;
          pb.resolve({ bearer: String(d.bearer), authPath: d.authPath || lastAuthPath });
        } else {
          pb.reject(new Error(d.error || "未获得 Bearer"));
        }
      }
      return;
    }
    if (d.type === "batch-done") {
      if (activeBatch && d.requestId && d.requestId !== activeBatch.requestId) return;
      finishActiveBatch(!!d.ok, d.text || (d.ok ? "完成" : "失败"), d);
    }
  }

  function onBackgroundMessage(msg) {
    try {
      if (!msg || msg.source !== "a3-batch-qa-bg") return;
      bgSeen = true;
      if (msg.type === "batch-status") {
        setStatus(msg.text || "", !!msg.error);
      } else if (msg.type === "batch-ack") {
        if (activeBatch && msg.requestId === activeBatch.requestId) {
          try {
            clearTimeout(activeBatch.ackTimer);
          } catch (e) {
            /* ignore */
          }
          setStatus("后台已确认批量 " + (msg.count != null ? msg.count : "") + " 个…");
        }
      } else if (msg.type === "batch-done") {
        if (activeBatch && msg.requestId && msg.requestId !== activeBatch.requestId) return;
        finishActiveBatch(!!msg.ok, msg.text || (msg.ok ? "完成" : "失败"), msg);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function installBridgeListener() {
    if (root.__a3BatchQaBridgeListening) return;
    root.__a3BatchQaBridgeListening = true;
    try {
      document.documentElement.addEventListener(BRIDGE_EVENT, function (ev) {
        try {
          onBridgeMessage(ev.detail);
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
    try {
      root.addEventListener("message", function (ev) {
        try {
          onBridgeMessage(ev.data);
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
    if (hasExtensionRuntime) {
      try {
        chrome.runtime.onMessage.addListener(function (msg) {
          onBackgroundMessage(msg);
        });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function requestBearer(sessionId) {
    return new Promise(function (resolve, reject) {
      var requestId = newMsgId();
      pendingBearer = {
        requestId: requestId,
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          if (!pendingBearer || pendingBearer.requestId !== requestId) return;
          pendingBearer = null;
          reject(new Error("鉴权超时：请先手动点一次「下载问答」"));
        }, AUTH_WAIT_MS),
      };
      postToBridge({ type: "ensure-auth", sessionId: sessionId || "", requestId: requestId });
    });
  }

  function sendToBackground(payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ source: BRIDGE_SOURCE }, payload),
          function (resp) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || "background 无响应"));
              return;
            }
            resolve(resp);
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Prefer Port so SW stays alive; never ship file bytes over messaging (zip in background).
   * Completion is via port messages → onBackgroundMessage (not sendResponse).
   */
  function startBackgroundBatch(payload) {
    return new Promise(function (resolve, reject) {
      if (!hasExtensionRuntime) {
        reject(new Error("无 chrome.runtime"));
        return;
      }
      try {
        if (typeof chrome.runtime.connect !== "function") {
          // very old fallback
          sendToBackground(payload).then(resolve).catch(reject);
          return;
        }
        var port = chrome.runtime.connect({ name: "a3-batch-qa" });
        activePort = port;
        var gotAck = false;
        port.onMessage.addListener(function (msg) {
          try {
            if (!msg) return;
            if (!msg.source) msg.source = "a3-batch-qa-bg";
            if (msg.type === "batch-ack") gotAck = true;
            onBackgroundMessage(msg);
            if (msg.type === "batch-done" && (!payload.requestId || msg.requestId === payload.requestId)) {
              try {
                port.disconnect();
              } catch (e) {
                /* ignore */
              }
              if (activePort === port) activePort = null;
              resolve(msg);
            }
          } catch (e) {
            /* ignore */
          }
        });
        port.onDisconnect.addListener(function () {
          if (activePort === port) activePort = null;
          var errMsg = "";
          try {
            errMsg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "";
          } catch (e) {
            /* ignore */
          }
          // If batch already finished, ignore disconnect
          if (!activeBatch || activeBatch.requestId !== payload.requestId) return;
          // If we never got ack, fail fast; if mid-batch, report SW drop
          if (!gotAck) {
            finishActiveBatch(
              false,
              BG_REQUIRED_MSG + (errMsg ? "：" + errMsg : "")
            );
            reject(new Error(errMsg || "port disconnected before ack"));
          } else {
            finishActiveBatch(
              false,
              "后台连接中断（service worker 可能被回收）。已恢复按钮，请重试。"
            );
            reject(new Error(errMsg || "port disconnected mid-batch"));
          }
        });
        port.postMessage(Object.assign({ source: BRIDGE_SOURCE }, payload));
      } catch (err) {
        reject(err);
      }
    });
  }

  function buildEntryFilename(user, recent, sessionId, withSessionSuffix) {
    var u = sanitizeFilenamePart(user || "unknown", 60);
    var r = sanitizeFilenamePart(recent || "unknown", 60);
    var base = u + "_" + r;
    if (withSessionSuffix) base = base + "_" + shortSessionSuffix(sessionId);
    return base + ".txt";
  }

  function buildJobs(ids) {
    var used = Object.create(null);
    return ids.map(function (id) {
      var meta = readRowMeta(id);
      var name = buildEntryFilename(meta.user, meta.recent, id, false);
      if (used[name]) name = buildEntryFilename(meta.user, meta.recent, id, true);
      var n = 2;
      var base = name;
      while (used[name]) {
        name = base.replace(/\.txt$/i, "") + "-" + n + ".txt";
        n++;
      }
      used[name] = true;
      return { sessionId: id, fileName: name, user: meta.user, recent: meta.recent };
    });
  }

  /* ---- DOM helpers (read-only on page table) ---- */
  function findExecLogTable() {
    return (
      document.querySelector(".exec-log__table table") ||
      document.querySelector(".exec-log table.ant-table-tbody") ||
      document.querySelector(".exec-log table") ||
      document.querySelector("table")
    );
  }

  /**
   * Map thead title → data cell index.
   * Ant Table may have expand/measure cols; match by visible header text.
   * Known columns: 会话 | 最近一轮 | 状态 | 用户 | Agent | …
   */
  function resolveColumnIndexes() {
    var out = { user: -1, recent: -1 };
    try {
      var table = findExecLogTable();
      if (!table) return out;
      // Prefer header table (antd may split header/body tables)
      var headerTable =
        document.querySelector(".exec-log__table .ant-table-header table") ||
        document.querySelector(".exec-log .ant-table-header table") ||
        table;
      var ths = headerTable.querySelectorAll("thead th");
      if (!ths.length) ths = table.querySelectorAll("thead th");
      for (var i = 0; i < ths.length; i++) {
        var title = (ths[i].textContent || "").replace(/\s+/g, " ").trim();
        if (title === "用户" || title.indexOf("用户") === 0) out.user = i;
        if (title === "最近一轮" || title.indexOf("最近一轮") === 0) out.recent = i;
      }
      // Fallback to known order from production page JS when headers not found
      if (out.user < 0 || out.recent < 0) {
        // 会话(0) 最近一轮(1) 状态(2) 用户(3) …
        if (out.recent < 0) out.recent = 1;
        if (out.user < 0) out.user = 3;
      }
    } catch (e) {
      out = { user: 3, recent: 1 };
    }
    return out;
  }

  function cellText(tr, colIndex) {
    if (!tr || colIndex < 0) return "";
    var cells = tr.querySelectorAll(":scope > td");
    if (!cells.length) cells = tr.querySelectorAll("td");
    if (colIndex >= cells.length) return "";
    return (cells[colIndex].textContent || "").replace(/\s+/g, " ").trim();
  }

  function findRowBySessionId(sessionId) {
    try {
      var nodes = document.querySelectorAll("tr[data-row-key]");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-row-key") === sessionId) return nodes[i];
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function readRowMeta(sessionId) {
    var cols = resolveColumnIndexes();
    var tr = findRowBySessionId(sessionId);
    var user = tr ? cellText(tr, cols.user) : "";
    var recent = tr ? cellText(tr, cols.recent) : "";
    if (!user) user = "unknown";
    if (!recent) recent = "unknown";
    // em-dash / placeholder
    if (user === "—" || user === "-" || user === "–") user = "unknown";
    if (recent === "—" || recent === "-" || recent === "–") recent = "unknown";
    return { user: user, recent: recent, sessionId: sessionId };
  }

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
        // skip antd measure rows
        if (nodes[i].classList && nodes[i].classList.contains("ant-table-measure-row")) continue;
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
    el.textContent = sanitizeUiError(text || "");
    el.className = isError ? "is-error" : "";
  }

  function pingBackground() {
    return new Promise(function (resolve) {
      if (!hasExtensionRuntime || typeof chrome.runtime.sendMessage !== "function") {
        bgAlive = false;
        resolve({ ok: false, reason: "no-runtime" });
        return;
      }
      try {
        chrome.runtime.sendMessage({ source: BRIDGE_SOURCE, type: "ping-bg" }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            bgAlive = false;
            bgVersion = "";
            resolve({ ok: false, reason: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no-pong" });
            return;
          }
          bgAlive = true;
          bgSeen = true;
          bgVersion = resp.version || "";
          resolve(resp);
        });
      } catch (err) {
        bgAlive = false;
        resolve({ ok: false, reason: String(err && err.message ? err.message : err) });
      }
    });
  }

  function getCapturedBearerFromBg() {
    return new Promise(function (resolve) {
      if (!hasExtensionRuntime) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage({ source: BRIDGE_SOURCE, type: "get-captured-bearer" }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok || !resp.bearer) {
            resolve(null);
            return;
          }
          resolve({ bearer: String(resp.bearer), authPath: resp.authPath || "webRequest" });
        });
      } catch (e) {
        resolve(null);
      }
    });
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
      var meta = readRowMeta(id);
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!selected[id];
      input.addEventListener("change", function () {
        onToggle(id, input.checked);
      });
      var span = document.createElement("span");
      var display = meta.user + "_" + meta.recent;
      span.textContent = display.length > 36 ? display.slice(0, 34) + "…" : display;
      span.title = display + "\n" + id + " → " + buildEntryFilename(meta.user, meta.recent, id, false);
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
      '    <button type="button" class="secondary" id="a3-batch-qa-refresh-auth">同步鉴权</button>',
      '    <button type="button" id="a3-batch-qa-download" disabled>批量下载问答</button>',
      "  </div>",
      '  <div id="a3-batch-qa-list"></div>',
      '  <div id="a3-batch-qa-status">v' +
      VERSION +
      ' · 后台下载防 CORS · 文件名=用户_最近一轮.txt</div>',
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
    document.getElementById("a3-batch-qa-refresh-auth").addEventListener("click", function () {
      setStatus("正在截获页面鉴权（可能触发一次「下载问答」）…");
      var first = selectedIds()[0] || (readPageSessionIds()[0] || "");
      requestBearer(first)
        .then(function (r) {
          setStatus("鉴权就绪（" + (r.authPath || "captured") + "），可批量（走扩展后台）");
        })
        .catch(function (err) {
          setStatus(String(err && err.message ? err.message : err), true);
        });
      setTimeout(function () {
        if (!bridgeSeen) {
          setStatus(BG_REQUIRED_MSG + "（页面桥接无响应）", true);
        }
      }, BRIDGE_ACK_MS);
    });
    document.getElementById("a3-batch-qa-download").addEventListener("click", function () {
      runBatch().catch(function (err) {
        clearBusy(String(err && err.message ? err.message : err), true);
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

  function runBatch() {
    var ids = selectedIds();
    if (!ids.length || busy) return Promise.resolve();
    if (activeBatch) {
      clearBusy("上一批尚未结束，请稍候", true);
      return Promise.resolve();
    }
    if (!hasExtensionRuntime) {
      clearBusy(BG_REQUIRED_MSG, true);
      return Promise.resolve();
    }

    busy = true;
    updateDownloadButton();
    var jobs = buildJobs(ids);
    var zipName = "execution-qa-" + zipStamp() + ".zip";
    var requestId = newMsgId();
    var overallMs = Math.min(
      BATCH_OVERALL_CAP_MS,
      BATCH_OVERALL_BASE_MS + jobs.length * BATCH_OVERALL_PER_MS
    );

    return new Promise(function (resolve, reject) {
      var ab = {
        requestId: requestId,
        resolve: resolve,
        reject: reject,
        ackTimer: null,
        doneTimer: null,
      };
      activeBatch = ab;

      ab.doneTimer = setTimeout(function () {
        if (!activeBatch || activeBatch.requestId !== requestId) return;
        try {
          if (activePort) activePort.disconnect();
        } catch (e) {
          /* ignore */
        }
        finishActiveBatch(
          false,
          "批量超时（" + Math.round(overallMs / 1000) + "s）。按钮已恢复，可重试。"
        );
      }, overallMs);

      (async function () {
        setStatus("0/3 检查扩展后台…");
        var ping = await pingBackground();
        if (!ping || !ping.ok) {
          throw new Error(BG_REQUIRED_MSG);
        }
        setStatus("1/3 后台在线 v" + (ping.version || VERSION) + "，获取 Bearer…");

        var auth = await getCapturedBearerFromBg();
        if (!auth || !auth.bearer) {
          // warm DOM click / XHR observe via MAIN bridge, then re-read webRequest capture
          try {
            auth = await requestBearer(jobs[0].sessionId);
          } catch (e) {
            auth = null;
          }
          var again = await getCapturedBearerFromBg();
          if (again && again.bearer) auth = again;
        }
        if (!auth || !auth.bearer) {
          throw new Error("鉴权失败：Bearer 为空。请先手动点一次「下载问答」再批量。");
        }
        setStatus("2/3 鉴权就绪（" + (auth.authPath || "captured") + "），Port → 后台下载…");

        ab.ackTimer = setTimeout(function () {
          if (!activeBatch || activeBatch.requestId !== requestId) return;
          finishActiveBatch(false, BG_REQUIRED_MSG + "（批量确认超时）");
        }, BRIDGE_ACK_MS);

        startBackgroundBatch({
          type: "batch-download",
          requestId: requestId,
          jobs: jobs.map(function (j) {
            return { sessionId: j.sessionId, fileName: j.fileName };
          }),
          bearer: auth.bearer,
          authPath: auth.authPath,
          agentBase: agentBase(),
          zipName: zipName,
        }).catch(function () {
          /* finishActiveBatch already called on disconnect / errors */
        });
      })().catch(function (err) {
        finishActiveBatch(false, String(err && err.message ? err.message : err));
      });
    });
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
      installBridgeListener();
      postToBridge({ type: "ping", requestId: newMsgId() });
      postToBridge({ type: "request-auth" });
      pingBackground().then(function (resp) {
        if (resp && resp.ok) {
          try {
            setStatus(
              "扩展后台在线 v" +
                (resp.version || VERSION) +
                (resp.hasCapturedBearer ? "；已截获 Bearer" : "；待截获 Bearer")
            );
          } catch (e) {
            /* ignore */
          }
        }
      });
      setTimeout(function () {
        if (!hasExtensionRuntime || !bgAlive) {
          try {
            setStatus(BG_REQUIRED_MSG, true);
          } catch (e) {
            /* ignore */
          }
        } else if (!bridgeSeen) {
          try {
            setStatus("警告：后台在线但页面桥接未就绪，请硬刷新。", true);
          } catch (e) {
            /* ignore */
          }
        }
      }, 3000);
      tick();
      pollTimer = setInterval(tick, POLL_MS);
      try {
        console.info("[a3-batch-qa] started v" + VERSION + " (background download)");
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
    VARIANT: VARIANT,
    VERSION: VERSION,
  };
});


    if (window.A3ExecLogBatchQa) window.A3ExecLogBatchQa.start();
  } catch (err) {
    try { console.error("[a3-batch-qa] boot", err); } catch (e) {}
  }
})();
