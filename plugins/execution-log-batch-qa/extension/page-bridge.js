/**
 * MAIN-world auth bridge (v1.0.8).
 * document_start: observe page Agent Authorization (same Bearer as 「下载问答」).
 * Does NOT download Agent files here (page→agent hits CORS → Failed to fetch).
 * ISOLATED UI forwards bearer to MV3 background Port for host_permissions fetch.
 */
(function () {
  "use strict";
  try {
    if (window.__a3BatchQaBridgeInstalled) return;
    window.__a3BatchQaBridgeInstalled = true;

    var SOURCE = "a3-batch-qa";
    var EVENT = "__a3_batch_qa";
    var VERSION = "1.0.8";
    var AUTH_MS = 12000;

    var agentBearer = "";
    var authPath = "";
    var suppressOnce = false;
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

    /* observe only — never replace Agent responses except warm-suppress */
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
          status("鉴权中: 等待页面 Agent Bearer…");
          await new Promise(function (r) {
            setTimeout(r, 80);
          });
          if (agentBearer) return agentBearer;

          // Capture the real Agent Bearer from page 「下载问答」 (do not page-fetch Agent — CORS)
          status("鉴权中: 触发「下载问答」截获 Authorization…");
          if (await warmCaptureByClick(preferredSessionId)) return agentBearer;

          await new Promise(function (r) {
            setTimeout(r, 400);
          });
          if (agentBearer) return agentBearer;

          // Last resort: login token as candidate (background validates; may 401)
          var login = readLoginToken();
          if (login) {
            rememberBearer(login, "login-token-candidate");
            status("未截获 Agent Bearer，尝试登录 token 交后台验证…");
            return agentBearer;
          }

          throw new Error(
            "鉴权失败（未截获 Agent Authorization）。请先手动点一次「下载问答」，再重试批量。"
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
      // Ignore batch-run in MAIN — downloads moved to background (CORS)
      if (d.type === "batch-run") {
        emit({
          type: "batch-ack",
          requestId: d.requestId,
          action: "rejected-use-background",
          count: 0,
        });
        status("请使用扩展后台下载（页面直连 Agent 会 CORS Failed to fetch）", true);
        emit({
          type: "batch-done",
          requestId: d.requestId,
          ok: false,
          text: "v1.0.8：下载已改走扩展 background Port，请确认已加载带 background 的扩展包并硬刷新",
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
            status("鉴权已就绪（" + (authPath || "captured") + "）→ 交由扩展后台下载");
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

    emit({ type: "bridge-ready", version: VERSION, downloadVia: "background" });
  } catch (err) {
    try {
      console.error("[a3-batch-qa-bridge]", err);
    } catch (e) {
      /* ignore */
    }
  }
})();
