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
