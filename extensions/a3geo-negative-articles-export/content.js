(function () {
  if (window.__A3GEO_NEG_EXPORT_CONTENT__) return;
  window.__A3GEO_NEG_EXPORT_CONTENT__ = true;

  var SOURCE = "a3geo-neg-export";
  var injected = false;
  var pending = null;
  var utils = globalThis.A3GeoExportUtils;

  function showBanner(message, isError) {
    var id = "a3geo-neg-export-cs-banner";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      Object.assign(el.style, {
        position: "fixed",
        top: "12px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        maxWidth: "90vw",
        padding: "10px 14px",
        borderRadius: "8px",
        color: "#fff",
        fontSize: "13px",
        boxShadow: "0 8px 24px rgba(0,0,0,.2)",
        fontFamily: "system-ui,-apple-system,sans-serif"
      });
      document.documentElement.appendChild(el);
    }
    el.style.background = isError ? "#b42318" : "#16786e";
    el.textContent = message;
    clearTimeout(el.__timer);
    el.__timer = setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, isError ? 10000 : 5000);
  }

  function injectPageScript() {
    if (injected && window.__A3GEO_NEG_EXPORT_CS_READY__) {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        injected = true;
        window.__A3GEO_NEG_EXPORT_CS_READY__ = true;
        resolve();
      }
      function fail(err) {
        if (settled) return;
        settled = true;
        reject(err || new Error("注入页面脚本失败"));
      }

      window.addEventListener(
        "a3geo-neg-export-ready",
        function onReady() {
          window.removeEventListener("a3geo-neg-export-ready", onReady);
          done();
        },
        { once: true }
      );

      var s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      s.onload = function () {
        // ready event may have already fired; give it a tick
        setTimeout(function () {
          if (!settled) done();
        }, 50);
      };
      s.onerror = function () {
        fail(new Error("无法加载 injected.js，请重新加载扩展后刷新页面"));
      };
      (document.head || document.documentElement).appendChild(s);
      setTimeout(function () {
        if (!settled) fail(new Error("注入超时，请刷新舆情页后重试"));
      }, 8000);
    });
  }

  function requestPageExport(format, source) {
    window.postMessage(
      {
        source: SOURCE,
        direction: "to-page",
        type: "export",
        format: format || "both",
        sourceClick: source || "popup"
      },
      "*"
    );
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.source !== SOURCE || data.direction !== "from-page") {
      return;
    }

    if (data.type === "progress") {
      showBanner(data.message || "导出中…", false);
      try {
        chrome.runtime.sendMessage({
          type: "export-progress",
          message: data.message
        });
      } catch (e) {}
      return;
    }

    if (data.type === "error") {
      showBanner(data.message || "导出失败", true);
      if (pending) {
        pending.reject(new Error(data.message || "导出失败"));
        pending = null;
      }
      return;
    }

    if (data.type !== "done") return;

    try {
      if (!utils || typeof utils.downloadRows !== "function") {
        throw new Error("导出工具未加载，请重新加载扩展");
      }
      var result = utils.downloadRows(
        data.rows || [],
        data.meta || {},
        data.format || "both"
      );
      showBanner(
        "导出完成：共 " + (data.total || (data.rows || []).length) + " 条，已开始下载",
        false
      );
      if (pending) {
        pending.resolve({
          ok: true,
          total: data.total || (data.rows || []).length,
          format: data.format,
          meta: data.meta,
          filenames: result.filenames
        });
        pending = null;
      }
    } catch (err) {
      var message = (err && err.message) || String(err);
      showBanner(message, true);
      if (pending) {
        pending.reject(err);
        pending = null;
      }
    }
  });

  async function runExport(format, source) {
    await injectPageScript();
    if (pending) {
      throw new Error("已有导出任务进行中");
    }
    var resultPromise = new Promise(function (resolve, reject) {
      pending = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (pending) {
          pending.reject(new Error("导出超时，请刷新页面后重试"));
          pending = null;
        }
      }, 180000);
    });
    requestPageExport(format, source);
    return resultPromise;
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== "export-negative-articles") return;
    runExport(msg.format || "both", "popup")
      .then(function (r) {
        sendResponse(r);
      })
      .catch(function (err) {
        sendResponse({
          ok: false,
          error: (err && err.message) || String(err)
        });
      });
    return true;
  });

  // Warm inject on sentiment pages so FAB appears.
  if (/\/monitor\/sentiment/.test(location.pathname)) {
    injectPageScript().catch(function (err) {
      showBanner((err && err.message) || "扩展注入失败，请刷新页面", true);
    });
  }
})();
