function selectedFormat() {
  var el = document.querySelector('input[name="format"]:checked');
  return (el && el.value) || "both";
}

function setStatus(text, kind) {
  var status = document.getElementById("status");
  status.textContent = text || "";
  status.className = "status" + (kind ? " " + kind : "");
}

async function getSentimentTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  if (!tab || !tab.id) throw new Error("未找到当前标签页");
  if (!tab.url || tab.url.indexOf("geo.a3database.cn") === -1) {
    throw new Error("请先打开并激活 https://geo.a3database.cn 舆情页标签");
  }
  if (tab.url.indexOf("/monitor/sentiment") === -1) {
    throw new Error("请先进入「品牌监测 → 品牌舆情追踪」(/monitor/sentiment)");
  }
  return tab;
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["lib/export-utils.js", "content.js"]
  });
}

document.getElementById("exportBtn").addEventListener("click", async function () {
  var btn = document.getElementById("exportBtn");
  btn.disabled = true;
  setStatus("正在导出…请同时看页面顶部绿色/红色提示条");

  var onProgress = function (msg) {
    if (msg && msg.type === "export-progress") {
      setStatus(msg.message || "导出中…");
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    var tab = await getSentimentTab();
    var format = selectedFormat();

    var response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "export-negative-articles",
        format: format
      });
    } catch (e) {
      setStatus("正在注入扩展脚本…");
      await injectContent(tab.id);
      // small delay so listeners attach
      await new Promise(function (r) {
        setTimeout(r, 200);
      });
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "export-negative-articles",
        format: format
      });
    }

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "导出失败");
    }

    setStatus("完成：共 " + response.total + " 条，浏览器应已开始下载", "ok");
  } catch (err) {
    setStatus((err && err.message) || String(err), "error");
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    btn.disabled = false;
  }
});
