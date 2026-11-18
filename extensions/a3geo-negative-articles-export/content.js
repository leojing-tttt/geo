(function () {
  const EVENT_REQ = "a3geo-neg-export-request";
  const EVENT_RES = "a3geo-neg-export-result";
  let injected = false;
  let pending = null;

  function injectPageScript() {
    if (injected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      s.onload = () => {
        injected = true;
        s.remove();
        resolve();
      };
      s.onerror = () => reject(new Error("注入页面脚本失败"));
      (document.documentElement || document.head).appendChild(s);
    });
  }

  function requestDownload(detail) {
    return chrome.runtime.sendMessage({
      type: "download-export",
      rows: detail.rows,
      meta: detail.meta,
      format: detail.format || "both"
    });
  }

  window.addEventListener(EVENT_RES, async (ev) => {
    const detail = ev.detail || {};
    if (detail.type === "progress") {
      chrome.runtime.sendMessage({
        type: "export-progress",
        message: detail.message,
        progress: detail.progress
      });
      return;
    }

    if (detail.type === "error") {
      if (pending) {
        pending.reject(new Error(detail.message || "导出失败"));
        pending = null;
      }
      return;
    }

    if (detail.type !== "done" || !detail.rows) return;

    try {
      const dl = await requestDownload(detail);
      if (!dl || !dl.ok) {
        throw new Error((dl && dl.error) || "下载失败");
      }
      if (pending) {
        pending.resolve({
          ok: true,
          total: detail.total,
          format: detail.format,
          meta: detail.meta,
          filenames: dl.filenames
        });
        pending = null;
      }
    } catch (err) {
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
    const resultPromise = new Promise((resolve, reject) => {
      pending = { resolve, reject };
      setTimeout(() => {
        if (pending) {
          pending.reject(new Error("导出超时，请刷新页面后重试"));
          pending = null;
        }
      }, 180000);
    });
    window.dispatchEvent(
      new CustomEvent(EVENT_REQ, {
        detail: { format: format || "both", source: source || "popup" }
      })
    );
    return resultPromise;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "export-negative-articles") return;
    runExport(msg.format || "both", "popup")
      .then((r) => sendResponse(r))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: (err && err.message) || String(err)
        })
      );
    return true;
  });

  if (location.pathname.includes("/monitor/sentiment")) {
    injectPageScript().catch(() => {});
  }
})();
