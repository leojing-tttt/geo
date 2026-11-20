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
