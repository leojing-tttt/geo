/**
 * MAIN-world download engine (v1.0.5).
 * document_start: observe page Agent Authorization (same Bearer the row 「下载问答」 uses).
 * Batch downloads run HERE with that Bearer — ISOLATED UI never calls /me/auto.
 */
(function () {
  "use strict";
  try {
    if (window.__a3BatchQaBridgeInstalled) return;
    window.__a3BatchQaBridgeInstalled = true;

    var SOURCE = "a3-batch-qa";
    var VARIANT = "brief";
    var agentBearer = "";
    var authPath = "";
    var suppressOnce = false;
    var busy = false;

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

    function post(msg) {
      try {
        var payload = { source: SOURCE };
        for (var k in msg) if (Object.prototype.hasOwnProperty.call(msg, k)) payload[k] = msg[k];
        window.postMessage(payload, location.origin);
      } catch (e) {
        try {
          window.postMessage(payload, "*");
        } catch (e2) {
          /* ignore */
        }
      }
    }

    function status(text, isError) {
      post({ type: "batch-status", text: text || "", error: !!isError });
    }

    /* ---- early fetch observe (must not break page) ---- */
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
              // Abort page single-file download UI; auth already captured from request headers
              return Promise.reject(new Error("a3-batch-qa-auth-warm"));
            }
          }
        } catch (e) {
          /* ignore */
        }
        return origFetch.apply(this, arguments);
      };
    }

    // XHR observe (alova may use XHR adapter in some builds)
    try {
      var XO = XMLHttpRequest.prototype.open;
      var XS = XMLHttpRequest.prototype.setRequestHeader;
      var XSend = XMLHttpRequest.prototype.send;
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
      XMLHttpRequest.prototype.send = function () {
        return XSend.apply(this, arguments);
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
      // Use a guaranteed-nonexistent id — 401 AUTH_INVALID vs missing key tells us little;
      // success is unlikely; we check "not AUTH_INVALID for wrong key shape" is hard.
      // Instead: if list has a real session row, probe that id with HEAD-like GET and accept 200.
      var sid = "";
      try {
        var tr = document.querySelector("tr[data-row-key]");
        if (tr) sid = tr.getAttribute("data-row-key") || "";
      } catch (e) {
        /* ignore */
      }
      if (!sid || !token) return false;
      try {
        var res = await origFetch.call(window, downloadUrl(sid), {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "*/*",
            Authorization: "Bearer " + token,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        if (res.ok) {
          rememberBearer(token, label);
          // consume body so connection frees; discard
          try {
            await res.arrayBuffer();
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        // 401 → wrong token type
        return false;
      } catch (e) {
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
        // any on page
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
          if (agentBearer || Date.now() - started > 4000) {
            clearInterval(timer);
            suppressOnce = false;
            if (agentBearer) authPath = authPath || "warm-click-capture";
            resolve(!!agentBearer);
          }
        }, 50);
      });
    }

    async function ensureAgentBearer(preferredSessionId) {
      if (agentBearer) return agentBearer;

      // 1) already observed from list/detail traffic (document_start hook)
      await new Promise(function (r) {
        setTimeout(r, 50);
      });
      if (agentBearer) return agentBearer;

      // 2) try page login token directly against Agent download (no /me/auto)
      var login = readLoginToken();
      if (login) {
        status("尝试用页面登录 token 直连 Agent…");
        if (await probeBearer(login, "login-token-direct")) return agentBearer;
      }

      // 3) click page 「下载问答」 once to reuse the exact in-page Authorization builder
      status("正在触发页面「下载问答」以截获鉴权…");
      if (await warmCaptureByClick(preferredSessionId)) return agentBearer;

      // wait a bit more in case SPA fires late
      await new Promise(function (r) {
        setTimeout(r, 800);
      });
      if (agentBearer) return agentBearer;

      throw new Error(
        "无法截获页面 Agent 鉴权。请先手动点击一次表格里的「下载问答」，看到文件开始下载后，再点批量下载。"
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
      var res = await origFetch.call(window, downloadUrl(sessionId), {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "*/*",
          Authorization: "Bearer " + token,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      return res;
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

    async function runBatch(jobs, zipName) {
      if (busy) {
        status("已有批量任务进行中", true);
        return;
      }
      busy = true;
      try {
        var list = uniqueNames(jobs || []);
        if (!list.length) throw new Error("没有可下载的会话");
        status("准备鉴权（截获页面 Agent Authorization）…");
        var token = await ensureAgentBearer(list[0].sessionId);
        status("鉴权成功（" + (authPath || "captured") + "），开始下载 " + list.length + " 个…");

        var files = [];
        var errors = [];
        for (var i = 0; i < list.length; i++) {
          var job = list[i];
          status("下载中 " + (i + 1) + "/" + list.length + " …");
          try {
            var res = await fetchBrief(job.sessionId, token);
            if (res.status === 401) {
              // token stale — try warm click again once
              agentBearer = "";
              token = await ensureAgentBearer(job.sessionId);
              res = await fetchBrief(job.sessionId, token);
            }
            if (!res.ok) {
              var detail = "";
              try {
                detail = (await res.text()).slice(0, 120);
              } catch (e) {
                /* ignore */
              }
              throw new Error("HTTP " + res.status + (detail ? ": " + detail : ""));
            }
            var buf = new Uint8Array(await res.arrayBuffer());
            files.push({ name: job.fileName, data: buf });
          } catch (err) {
            errors.push(job.sessionId + ": " + (err && err.message ? err.message : err));
          }
        }
        if (!files.length) throw new Error(errors[0] || "全部下载失败");
        var zname = zipName || "execution-qa.zip";
        triggerZipDownload(buildZip(files), zname);
        var msg =
          "已打包 " +
          files.length +
          " 个 → " +
          zname +
          "（鉴权: " +
          (authPath || "captured") +
          ")" +
          (errors.length ? "；失败 " + errors.length : "");
        status(msg, false);
        post({ type: "batch-done", ok: true, text: msg, authPath: authPath });
      } catch (err) {
        var text = String(err && err.message ? err.message : err);
        status(text, true);
        post({ type: "batch-done", ok: false, text: text });
      } finally {
        busy = false;
      }
    }

    window.addEventListener("message", function (ev) {
      try {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.source !== SOURCE) return;
        if (d.type === "request-auth") {
          post({
            type: "auth",
            hasAgentBearer: !!agentBearer,
            authPath: authPath || "",
            hasLoginToken: !!readLoginToken(),
          });
          // do not call /me/auto
        } else if (d.type === "warm-auth") {
          ensureAgentBearer(d.sessionId || "")
            .then(function () {
              post({
                type: "auth",
                hasAgentBearer: !!agentBearer,
                authPath: authPath || "",
                ok: true,
              });
              status("鉴权已就绪（" + (authPath || "captured") + "）");
            })
            .catch(function (err) {
              status(String(err && err.message ? err.message : err), true);
              post({ type: "auth", hasAgentBearer: false, ok: false });
            });
        } else if (d.type === "batch-run") {
          runBatch(d.jobs || [], d.zipName || "execution-qa.zip");
        }
      } catch (e) {
        /* ignore */
      }
    });

    // announce ready
    post({ type: "bridge-ready", version: "1.0.5" });
  } catch (err) {
    try {
      console.error("[a3-batch-qa-bridge]", err);
    } catch (e) {
      /* ignore */
    }
  }
})();
