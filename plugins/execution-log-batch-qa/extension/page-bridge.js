/**
 * MAIN-world bridge (v1.0.4+).
 * Runs in the page JS context so it can:
 *  - read page localStorage.token (and common keys)
 *  - observe Authorization on real Agent download/fetch calls
 *  - optionally refresh AUTO token the same way the page does
 * Posts results to the ISOLATED content script via window.postMessage.
 *
 * Keep this tiny and fail-soft — never throw into the page.
 */
(function () {
  "use strict";
  try {
    if (window.__a3BatchQaBridgeInstalled) return;
    window.__a3BatchQaBridgeInstalled = true;

    var SOURCE = "a3-batch-qa";
    var agentBearer = "";
    var HOST_API = {
      "a3-lib.a3database.cn": "https://api.a3database.cn",
      "a3-pre-lib.a3database.cn": "https://pre-api.a3database.cn",
      "a3-test-lib.a3database.cn": "https://test-api.a3database.cn",
    };

    function apiBase() {
      return (HOST_API[location.hostname] || "https://api.a3database.cn").replace(/\/+$/, "");
    }

    function stripBearer(v) {
      if (!v) return "";
      var m = String(v).match(/^\s*Bearer\s+(.+)\s*$/i);
      return (m ? m[1] : v).trim();
    }

    function readLoginToken() {
      try {
        var keys = ["token", "access_token", "accessToken", "authToken", "Authorization"];
        for (var i = 0; i < keys.length; i++) {
          var v = localStorage.getItem(keys[i]);
          if (v && String(v).trim()) return stripBearer(v);
        }
      } catch (e) {
        /* ignore */
      }
      return "";
    }

    function postAuth(extra) {
      try {
        var payload = {
          source: SOURCE,
          type: "auth",
          loginToken: readLoginToken(),
          agentBearer: agentBearer || "",
        };
        if (extra) {
          for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
        }
        window.postMessage(payload, location.origin);
      } catch (e) {
        /* ignore */
      }
    }

    function rememberAgentBearer(v) {
      var t = stripBearer(v);
      if (!t) return;
      agentBearer = t;
      postAuth();
    }

    function headerAuth(headers) {
      try {
        if (!headers) return "";
        if (typeof headers.get === "function") {
          return headers.get("Authorization") || headers.get("authorization") || "";
        }
        return headers.Authorization || headers.authorization || "";
      } catch (e) {
        return "";
      }
    }

    // Observe only — must not break page fetch (skeleton bug class)
    try {
      var origFetch = window.fetch;
      if (typeof origFetch === "function" && !window.__a3BatchQaFetchObserved) {
        window.__a3BatchQaFetchObserved = true;
        window.fetch = function (input, init) {
          try {
            var url = typeof input === "string" ? input : input && input.url;
            if (url && /agent(-test)?\.a3database\.cn/i.test(String(url))) {
              var auth = headerAuth((init && init.headers) || (input && input.headers));
              if (auth) rememberAgentBearer(auth);
            }
          } catch (e) {
            /* ignore */
          }
          return origFetch.apply(this, arguments);
        };
      }
    } catch (e) {
      /* ignore */
    }

    async function refreshAutoToken() {
      var login = readLoginToken();
      if (!login) {
        postAuth({ autoError: "no-login-token" });
        return;
      }
      try {
        var res = await fetch(apiBase() + "/api/v1/sys/user-tokens/me/auto", {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + login,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        var json = null;
        try {
          json = await res.json();
        } catch (e) {
          json = null;
        }
        var token =
          json && json.data && json.data.token
            ? String(json.data.token)
            : json && json.token
              ? String(json.token)
              : "";
        if (token) {
          agentBearer = token;
          postAuth({ autoOk: true });
        } else {
          postAuth({
            autoError: "auto-401",
            autoHttp: res.status,
            autoCode: json && json.code,
          });
        }
      } catch (err) {
        postAuth({ autoError: String(err && err.message ? err.message : err) });
      }
    }

    window.addEventListener("message", function (ev) {
      try {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.source !== SOURCE) return;
        if (d.type === "request-auth") {
          postAuth();
          refreshAutoToken();
        }
      } catch (e) {
        /* ignore */
      }
    });

    // Initial publish + delayed refresh (page may set token just after idle)
    postAuth();
    setTimeout(function () {
      postAuth();
      refreshAutoToken();
    }, 800);
    setTimeout(postAuth, 2500);
  } catch (err) {
    try {
      console.error("[a3-batch-qa-bridge]", err);
    } catch (e) {
      /* ignore */
    }
  }
})();
