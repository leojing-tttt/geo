// ==UserScript==
// @name         A3 执行记录 · 批量下载问答
// @namespace    https://github.com/leojing-tttt/geo
// @version      1.0.6
// @description  批量下载「下载问答」；CustomEvent桥接+超时恢复；条目名=用户_最近一轮.txt
// @author       geo plugin
// @match        https://a3-lib.a3database.cn/*
// @match        https://a3-pre-lib.a3database.cn/*
// @match        https://a3-test-lib.a3database.cn/*
// @connect      api.a3database.cn
// @connect      pre-api.a3database.cn
// @connect      test-api.a3database.cn
// @connect      agent.a3database.cn
// @connect      agent-test.a3database.cn
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";
  try {
/**
 * MAIN-world download engine (v1.0.6).
 * document_start: observe page Agent Authorization.
 * Talks to ISOLATED UI via DOM CustomEvent (postMessage fallback).
 * Hard timeouts on auth / each download / overall — never hang forever.
 */
(function () {
  "use strict";
  try {
    if (window.__a3BatchQaBridgeInstalled) return;
    window.__a3BatchQaBridgeInstalled = true;

    var SOURCE = "a3-batch-qa";
    var EVENT = "__a3_batch_qa";
    var VARIANT = "brief";
    var VERSION = "1.0.6";
    var AUTH_MS = 12000;
    var PER_FILE_MS = 20000;
    var OVERALL_BASE_MS = 30000;
    var OVERALL_PER_FILE_MS = 22000;
    var OVERALL_CAP_MS = 10 * 60 * 1000;

    var agentBearer = "";
    var authPath = "";
    var suppressOnce = false;
    var busy = false;
    var handledIds = Object.create(null);

    var HOST_AGENT = {
      "a3-lib.a3database.cn": "https://agent.a3database.cn",
      "a3-pre-lib.a3database.cn": "https://agent.a3database.cn",
      "a3-test-lib.a3database.cn": "https://agent-test.a3database.cn",
    };

    function agentBase() {
      var origin = HOST_AGENT[location.hostname] || "https://agent.a3database.cn";
      return origin.replace(/\/+$/, "") + "/scope";
    }

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

    function headerAuth(headers) {
      try {
        if (!headers) return "";
        if (typeof headers.get === "function") {
          return headers.get("Authorization") || headers.get("authorization") || "";
        }
        if (Array.isArray(headers)) {
          for (var i = 0; i < headers.length; i++) {
            if (String(headers[i][0]).toLowerCase() === "authorization") return headers[i][1];
          }
          return "";
        }
        return headers.Authorization || headers.authorization || "";
      } catch (e) {
        return "";
      }
    }

    function isAgentUrl(url) {
      return url && /agent(-test)?\.a3database\.cn/i.test(String(url));
    }

    function isAgentDownloadUrl(url) {
      return isAgentUrl(url) && /\/admin\/conversations\/[^/]+\/download/i.test(String(url));
    }

    function newMsgId() {
      return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** Emit to ISOLATED (CustomEvent primary; postMessage backup). */
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

    function fetchWithTimeout(url, init, ms, label) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var opts = init || {};
      if (ctrl) {
        opts = {};
        for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
        opts.signal = ctrl.signal;
      }
      var p = origFetch.call(window, url, opts);
      var timed = withTimeout(p, ms, label || "请求");
      if (ctrl) {
        setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {
            /* ignore */
          }
        }, ms + 50);
      }
      return timed;
    }

    /* ---- early fetch / XHR observe ---- */
    var origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : input && input.url;
          if (isAgentUrl(url)) {
            var auth = headerAuth((init && init.headers) || (input && input.headers));
            if (auth) rememberBearer(auth, "page-fetch-observe");
            if (suppressOnce && isAgentDownloadUrl(url) && agentBearer) {
              suppressOnce = false;
              return Promise.reject(new Error("a3-batch-qa-auth-warm"));
            }
          }
        } catch (e) {
          /* ignore */
        }
        return origFetch.apply(this, arguments);
      };
    }

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

    function downloadUrl(sessionId) {
      return (
        agentBase() +
        "/admin/conversations/" +
        encodeURIComponent(sessionId) +
        "/download?variant=" +
        encodeURIComponent(VARIANT)
      );
    }

    async function probeBearer(token, label) {
      var sid = "";
      try {
        var tr = document.querySelector("tr[data-row-key]");
        if (tr) sid = tr.getAttribute("data-row-key") || "";
      } catch (e) {
        /* ignore */
      }
      if (!sid || !token) return false;
      try {
        status("探活鉴权: " + label + "…");
        var res = await fetchWithTimeout(
          downloadUrl(sid),
          {
            method: "GET",
            credentials: "include",
            headers: {
              Accept: "*/*",
              Authorization: "Bearer " + token,
              "X-Requested-With": "XMLHttpRequest",
            },
          },
          8000,
          "登录token探活"
        );
        // 401/403 → wrong token. Anything else (200/404/…) means Bearer accepted.
        if (res.status === 401 || res.status === 403) {
          try {
            if (res.body && res.body.cancel) res.body.cancel();
          } catch (e) {
            /* ignore */
          }
          return false;
        }
        rememberBearer(token, label);
        try {
          if (res.body && res.body.cancel) res.body.cancel();
          else await Promise.race([res.arrayBuffer(), new Promise(function (r) { setTimeout(r, 500); })]);
        } catch (e) {
          /* ignore */
        }
        return true;
      } catch (e) {
        status("探活失败: " + (e && e.message ? e.message : e), true);
        return false;
      }
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
        suppressOnce = true;
        var started = Date.now();
        try {
          btn.click();
        } catch (e) {
          suppressOnce = false;
          resolve(false);
          return;
        }
        var timer = setInterval(function () {
          if (agentBearer || Date.now() - started > 5000) {
            clearInterval(timer);
            suppressOnce = false;
            if (agentBearer) authPath = authPath || "warm-click-capture";
            resolve(!!agentBearer);
          }
        }, 50);
      });
    }

    async function ensureAgentBearer(preferredSessionId) {
      return withTimeout(
        (async function () {
          if (agentBearer) return agentBearer;
          status("鉴权中: 等待已截获的页面 Agent Bearer…");
          await new Promise(function (r) {
            setTimeout(r, 80);
          });
          if (agentBearer) return agentBearer;

          var login = readLoginToken();
          if (login) {
            if (await probeBearer(login, "login-token-direct")) return agentBearer;
          }

          status("鉴权中: 触发页面「下载问答」截获 Authorization…");
          if (await warmCaptureByClick(preferredSessionId)) return agentBearer;

          await new Promise(function (r) {
            setTimeout(r, 400);
          });
          if (agentBearer) return agentBearer;

          throw new Error(
            "鉴权失败（未截获 Agent Authorization）。请先手动点一次「下载问答」，再重试批量。"
          );
        })(),
        AUTH_MS,
        "鉴权"
      );
    }

    /* ---- ZIP (STORE) ---- */
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
      var enc = new TextEncoder();
      for (var i = 0; i < entries.length; i++) {
        var nameBytes = enc.encode(entries[i].name);
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
        centralParts.push(
          concatBytes([
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
          ])
        );
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

    function triggerZipDownload(bytes, filename) {
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

    async function fetchBrief(sessionId, token) {
      return fetchWithTimeout(
        downloadUrl(sessionId),
        {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "*/*",
            Authorization: "Bearer " + token,
            "X-Requested-With": "XMLHttpRequest",
          },
        },
        PER_FILE_MS,
        "下载 " + sessionId.slice(0, 8)
      );
    }

    function uniqueNames(jobs) {
      var used = Object.create(null);
      return jobs.map(function (j) {
        var name = j.fileName || j.sessionId + ".txt";
        if (!/\.txt$/i.test(name)) name += ".txt";
        var base = name;
        var n = 2;
        while (used[name]) {
          name = base.replace(/\.txt$/i, "") + "-" + n + ".txt";
          n++;
        }
        used[name] = true;
        return { sessionId: j.sessionId, fileName: name };
      });
    }

    async function runBatch(jobs, zipName, requestId) {
      if (busy) {
        status("已有批量任务进行中", true);
        emit({ type: "batch-done", ok: false, text: "已有批量任务进行中", requestId: requestId });
        return;
      }
      busy = true;
      var settled = false;
      var list = uniqueNames(jobs || []);
      var overallMs = Math.min(OVERALL_CAP_MS, OVERALL_BASE_MS + list.length * OVERALL_PER_FILE_MS);
      var files = [];
      var errors = [];

      function finish(ok, text, extra) {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        busy = false;
        var payload = { type: "batch-done", ok: !!ok, text: text || "", requestId: requestId };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
        status(text || "", !ok);
        emit(payload);
      }

      var overallTimer = setTimeout(function () {
        // Prefer partial ZIP if anything succeeded before overall timeout
        if (settled) return;
        if (files.length) {
          try {
            var zPartial = zipName || "execution-qa.zip";
            triggerZipDownload(buildZip(files), zPartial);
            finish(true, "整批超时，已打包部分 " + files.length + "/" + list.length + " → " + zPartial, {
              authPath: authPath,
              okCount: files.length,
              failCount: errors.length,
              partial: true,
            });
            return;
          } catch (e) {
            /* fall through */
          }
        }
        finish(false, "整批超时（" + Math.round(overallMs / 1000) + "s），已中止");
      }, overallMs);

      try {
        if (!list.length) throw new Error("没有可下载的会话");
        status("1/3 鉴权中…（限时 " + AUTH_MS / 1000 + "s）共 " + list.length + " 个");
        var token = await ensureAgentBearer(list[0].sessionId);
        if (settled) return;
        status(
          "2/3 鉴权成功（" +
            (authPath || "captured") +
            "），开始下载 0/" +
            list.length
        );

        for (var i = 0; i < list.length; i++) {
          if (settled) break;
          var job = list[i];
          status(
            "2/3 下载 " +
              (i + 1) +
              "/" +
              list.length +
              "（鉴权:" +
              (authPath || "?") +
              "）" +
              job.fileName
          );
          try {
            var res = await fetchBrief(job.sessionId, token);
            if (settled) break;
            if (res.status === 401) {
              status("Token 失效，重新鉴权…", true);
              agentBearer = "";
              token = await ensureAgentBearer(job.sessionId);
              res = await fetchBrief(job.sessionId, token);
            }
            if (!res.ok) {
              var detail = "";
              try {
                detail = (await withTimeout(res.text(), 3000, "读错误体")).slice(0, 100);
              } catch (e) {
                /* ignore */
              }
              throw new Error("HTTP " + res.status + (detail ? ": " + detail : ""));
            }
            var buf = new Uint8Array(await withTimeout(res.arrayBuffer(), PER_FILE_MS, "读正文"));
            files.push({ name: job.fileName, data: buf });
          } catch (err) {
            var em = String(err && err.message ? err.message : err);
            errors.push(job.fileName + ": " + em);
            status("失败 " + (i + 1) + "/" + list.length + " " + em, true);
          }
        }

        if (settled) return;
        if (!files.length) {
          throw new Error(errors[0] || "全部下载失败");
        }

        status("3/3 打包 ZIP（成功 " + files.length + "/" + list.length + "）…");
        var zname = zipName || "execution-qa.zip";
        triggerZipDownload(buildZip(files), zname);
        var msg =
          "已打包 " +
          files.length +
          "/" +
          list.length +
          " → " +
          zname +
          "（鉴权:" +
          (authPath || "captured") +
          ")" +
          (errors.length ? "；失败 " + errors.length : "");
        finish(true, msg, { authPath: authPath, okCount: files.length, failCount: errors.length });
      } catch (err) {
        if (!settled && files.length) {
          try {
            var zname2 = zipName || "execution-qa.zip";
            triggerZipDownload(buildZip(files), zname2);
            finish(true, "部分完成 " + files.length + "/" + list.length + " → " + zname2 + "；中断: " + (err && err.message ? err.message : err), {
              authPath: authPath,
              okCount: files.length,
              failCount: errors.length,
              partial: true,
            });
            return;
          } catch (e2) {
            /* fall through */
          }
        }
        finish(false, String(err && err.message ? err.message : err));
      } finally {
        busy = false;
        clearTimeout(overallTimer);
      }
    }

    function handleInbound(d) {
      if (!d || d.source !== SOURCE) return;
      // dedupe CustomEvent + postMessage duplicates
      if (d.msgId) {
        if (handledIds[d.msgId]) return;
        handledIds[d.msgId] = Date.now();
        // prune
        var keys = Object.keys(handledIds);
        if (keys.length > 40) {
          keys.sort(function (a, b) {
            return handledIds[a] - handledIds[b];
          });
          for (var i = 0; i < keys.length - 20; i++) delete handledIds[keys[i]];
        }
      }
      if (d.type === "ping" || d.type === "request-auth") {
        emit({
          type: "auth",
          hasAgentBearer: !!agentBearer,
          authPath: authPath || "",
          hasLoginToken: !!readLoginToken(),
          bridge: true,
          version: VERSION,
        });
        if (d.type === "ping") emit({ type: "pong", version: VERSION, requestId: d.requestId });
      } else if (d.type === "warm-auth") {
        emit({ type: "batch-ack", requestId: d.requestId, action: "warm-auth" });
        ensureAgentBearer(d.sessionId || "")
          .then(function () {
            emit({
              type: "auth",
              hasAgentBearer: !!agentBearer,
              authPath: authPath || "",
              ok: true,
              requestId: d.requestId,
            });
            status("鉴权已就绪（" + (authPath || "captured") + "）");
          })
          .catch(function (err) {
            status(String(err && err.message ? err.message : err), true);
            emit({ type: "auth", hasAgentBearer: false, ok: false, requestId: d.requestId });
          });
      } else if (d.type === "batch-run") {
        emit({
          type: "batch-ack",
          requestId: d.requestId,
          action: "batch-run",
          count: (d.jobs && d.jobs.length) || 0,
        });
        status("桥接已收到批量任务 " + ((d.jobs && d.jobs.length) || 0) + " 个…");
        runBatch(d.jobs || [], d.zipName || "execution-qa.zip", d.requestId);
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
        // do not require ev.source === window (ISOLATED→MAIN can differ)
        handleInbound(ev.data);
      } catch (e) {
        /* ignore */
      }
    });

    emit({ type: "bridge-ready", version: VERSION });
  } catch (err) {
    try {
      console.error("[a3-batch-qa-bridge]", err);
    } catch (e) {
      /* ignore */
    }
  }
})();

/**
 * A3 Agent Center — execution-log batch 「下载问答」 core (v1.0.6+).
 *
 * Safety rules (do NOT break page load):
 * - UI in ISOLATED: never MutationObserver / history rewrite / Ant Table cell injection
 * - Soft-poll for tr[data-row-key]; UI on document.body only
 * - Downloads + auth run in MAIN page-bridge (document_start fetch observe)
 * - ISOLATED↔MAIN via CustomEvent + postMessage; always clear busy on fail/timeout
 *
 * API (from production bundles):
 *   GET {agentBase}/admin/conversations/{sessionId}/download?variant=brief
 *   Authorization: same Bearer the page attaches to Agent requests
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

  var VERSION = "1.0.6";
  var VARIANT = "brief";
  var POLL_MS = 1500;
  var BRIDGE_ACK_MS = 2500;
  var BATCH_OVERALL_BASE_MS = 35000;
  var BATCH_OVERALL_PER_MS = 23000;
  var BATCH_OVERALL_CAP_MS = 10 * 60 * 1000;
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

  /* ---- MAIN bridge (CustomEvent + postMessage; downloads in page-bridge) ---- */
  var BRIDGE_SOURCE = "a3-batch-qa";
  var BRIDGE_EVENT = "__a3_batch_qa";
  var lastAuthPath = "";
  var bridgeSeen = false;
  var activeBatch = null; // { requestId, resolve, reject, ackTimer, doneTimer }
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
    if (uiText != null) setStatus(uiText, !!isError);
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
    clearBusy(text || (ok ? "完成" : "失败"), !ok);
    if (!ab) return;
    try {
      if (ok) ab.resolve(data || { ok: true, text: text });
      else ab.reject(new Error(text || "批量失败"));
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
          "桥接已确认（" +
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
        setStatus("页面 Agent 鉴权已就绪（" + (d.authPath || "captured") + "）");
      } else if (d.bridge) {
        setStatus(
          "桥接在线 v" +
            (d.version || "?") +
            (d.hasAgentBearer ? "；已有 Bearer" : "；尚无 Bearer，批量时会截获")
        );
      }
      return;
    }
    if (d.type === "batch-done") {
      if (activeBatch && d.requestId && d.requestId !== activeBatch.requestId) return;
      finishActiveBatch(!!d.ok, d.text || (d.ok ? "完成" : "失败"), d);
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
      ' · 文件名=用户_最近一轮.txt · 卡住会自动超时并恢复按钮</div>',
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
      setStatus("正在截获页面鉴权（限时 12s，可能触发一次「下载问答」）…");
      var first = selectedIds()[0] || (readPageSessionIds()[0] || "");
      postToBridge({ type: "warm-auth", sessionId: first, requestId: newMsgId() });
      setTimeout(function () {
        if (!bridgeSeen) {
          setStatus("桥接无响应：请移除旧扩展后加载 1.0.6，并硬刷新页面", true);
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
    busy = true;
    updateDownloadButton();
    var jobs = buildJobs(ids);
    var zipName = "execution-qa-" + zipStamp() + ".zip";
    var requestId = newMsgId();
    var overallMs = Math.min(
      BATCH_OVERALL_CAP_MS,
      BATCH_OVERALL_BASE_MS + jobs.length * BATCH_OVERALL_PER_MS
    );
    setStatus("发送批量任务 " + jobs.length + " 个到页面桥接…（等待确认 ≤" + BRIDGE_ACK_MS / 1000 + "s）");

    return new Promise(function (resolve, reject) {
      var ab = {
        requestId: requestId,
        resolve: resolve,
        reject: reject,
        ackTimer: null,
        doneTimer: null,
      };
      activeBatch = ab;

      ab.ackTimer = setTimeout(function () {
        if (!activeBatch || activeBatch.requestId !== requestId) return;
        finishActiveBatch(
          false,
          "页面桥接未响应（" +
            BRIDGE_ACK_MS / 1000 +
            "s）。请确认已安装 1.0.6、移除旧版后硬刷新；或先点一次「下载问答」。"
        );
      }, BRIDGE_ACK_MS);

      ab.doneTimer = setTimeout(function () {
        if (!activeBatch || activeBatch.requestId !== requestId) return;
        finishActiveBatch(
          false,
          "批量超时（" +
            Math.round(overallMs / 1000) +
            "s）且无完成回调。按钮已恢复，可重试。"
        );
      }, overallMs);

      try {
        postToBridge({
          type: "batch-run",
          jobs: jobs,
          zipName: zipName,
          requestId: requestId,
        });
      } catch (err) {
        finishActiveBatch(false, "发送桥接失败: " + (err && err.message ? err.message : err));
      }
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
      setTimeout(function () {
        if (!bridgeSeen) {
          try {
            setStatus("警告：未检测到页面桥接。请装 1.0.6 扩展并硬刷新本页。", true);
          } catch (e) {
            /* ignore */
          }
        }
      }, 3000);
      tick();
      pollTimer = setInterval(tick, POLL_MS);
      try {
        console.info("[a3-batch-qa] started v" + VERSION + " (CustomEvent bridge + timeouts)");
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
