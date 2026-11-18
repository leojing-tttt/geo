function selectedFormat() {
  const el = document.querySelector('input[name="format"]:checked');
  return (el && el.value) || "both";
}

function setStatus(text, kind) {
  const status = document.getElementById("status");
  status.textContent = text || "";
  status.className = "status" + (kind ? " " + kind : "");
}

async function getSentimentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) throw new Error("未找到当前标签页");
  if (!tab.url || !tab.url.includes("geo.a3database.cn")) {
    throw new Error("请先打开 https://geo.a3database.cn 并进入品牌舆情追踪页");
  }
  return tab;
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const btn = document.getElementById("exportBtn");
  btn.disabled = true;
  setStatus("正在导出…");

  const onProgress = (msg) => {
    if (msg && msg.type === "export-progress") {
      setStatus(msg.message || "导出中…");
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    const tab = await getSentimentTab();
    const format = selectedFormat();

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "export-negative-articles",
        format
      });
    } catch (e) {
      // Content script may not be ready yet (page opened before install).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "export-negative-articles",
        format
      });
    }

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "导出失败");
    }

    setStatus(`完成：共 ${response.total} 条，已触发下载`, "ok");
  } catch (err) {
    setStatus((err && err.message) || String(err), "error");
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    btn.disabled = false;
  }
});
