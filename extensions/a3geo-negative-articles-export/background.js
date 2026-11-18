// Keep a tiny service worker so the extension stays active.
// Downloads are performed in the content script (blob URLs work there).

chrome.runtime.onInstalled.addListener(function () {
  console.log("[A3GEO export] extension ready");
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "export-progress") {
    // Popup listens directly; acknowledge to avoid channel errors.
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
});
