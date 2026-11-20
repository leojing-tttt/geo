/**
 * MV3 service worker — downloads Agent brief txt + STORE zip (v1.0.8).
 * Extension host_permissions bypass page CORS.
 * Long batches use runtime Port so the SW is not unloaded mid-run.
 */
/* eslint-disable no-undef */
"use strict";

var VERSION = "1.0.8";
var VARIANT = "brief";
var PER_FILE_MS = 25000;

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

function downloadUrl(agentBase, sessionId) {
  return (
    String(agentBase).replace(/\/+$/, "") +
    "/admin/conversations/" +
    encodeURIComponent(sessionId) +
    "/download?variant=" +
    encodeURIComponent(VARIANT)
  );
}

function formatFetchError(err) {
  var em = String(err && err.message ? err.message : err);
  if (/aborted|AbortError/i.test(em)) return "下载超时（" + PER_FILE_MS / 1000 + "s）";
  if (/Failed to fetch|NetworkError|network/i.test(em)) {
    return "后台网络错误（" + em + "）— 非页面 CORS；检查 Agent 域名/网络";
  }
  return em;
}

function notifyTab(tabId, msg) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, Object.assign({ source: "a3-batch-qa-bg" }, msg), function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* ignore */
  }
}

async function fetchOne(agentBase, sessionId, bearer) {
  if (!bearer) throw new Error("缺少 Agent Bearer（空 token，未发起请求）");
  var ctrl = new AbortController();
  var timer = setTimeout(function () {
    try {
      ctrl.abort();
    } catch (e) {
      /* ignore */
    }
  }, PER_FILE_MS);
  try {
    var res = await fetch(downloadUrl(agentBase, sessionId), {
      method: "GET",
      headers: {
        Accept: "*/*",
        Authorization: "Bearer " + bearer,
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("鉴权无效 HTTP " + res.status + "（Bearer 被 Agent 拒绝，请重新点「下载问答」截获）");
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
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(formatFetchError(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} msg
 * @param {number|null} tabId
 * @param {(m: object) => void} push - progress/done sink (port and/or tab)
 */
async function runBatch(msg, tabId, push) {
  var jobs = msg.jobs || [];
  var bearer = String(msg.bearer || "").trim();
  var agentBase = String(msg.agentBase || "").trim();
  var zipName = msg.zipName || "execution-qa.zip";
  var requestId = msg.requestId || "";
  var authPath = msg.authPath || "";

  function emit(m) {
    var payload = Object.assign({ requestId: requestId }, m);
    try {
      push(payload);
    } catch (e) {
      /* ignore */
    }
    notifyTab(tabId, payload);
  }

  if (!bearer) throw new Error("缺少 Agent Bearer（请先点「下载问答」或「同步鉴权」）");
  if (!agentBase) throw new Error("缺少 agentBase");
  if (!jobs.length) throw new Error("没有可下载的会话");

  emit({
    type: "batch-status",
    text: "后台下载启动（扩展绕过 CORS）0/" + jobs.length + " 鉴权:" + (authPath || "bearer"),
  });

  var files = [];
  var errors = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var name = job.fileName || job.sessionId + ".txt";
    emit({
      type: "batch-status",
      text: "后台下载 " + (i + 1) + "/" + jobs.length + " " + name,
    });
    try {
      var data = await fetchOne(agentBase, job.sessionId, bearer);
      files.push({ name: name, data: data });
    } catch (err) {
      var em = String(err && err.message ? err.message : err);
      errors.push(name + ": " + em);
      emit({
        type: "batch-status",
        text: "失败 " + (i + 1) + "/" + jobs.length + " " + em,
        error: true,
      });
      // Hard-stop if auth is clearly dead — avoid 29 identical 401s
      if (/鉴权无效 HTTP 401|鉴权无效 HTTP 403/.test(em)) {
        throw new Error(em + "；已中止剩余 " + (jobs.length - i - 1) + " 个");
      }
    }
  }

  if (!files.length) throw new Error(errors[0] || "全部下载失败");

  emit({
    type: "batch-status",
    text: "打包 ZIP（成功 " + files.length + "/" + jobs.length + "）…",
  });

  var zipBytes = buildZip(files);
  var blob = new Blob([zipBytes], { type: "application/zip" });
  var url = URL.createObjectURL(blob);

  try {
    await new Promise(function (resolve, reject) {
      chrome.downloads.download(
        {
          url: url,
          filename: zipName,
          saveAs: false,
          conflictAction: "uniquify",
        },
        function (downloadId) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "downloads API 失败"));
            return;
          }
          resolve(downloadId);
        }
      );
    });
  } finally {
    setTimeout(function () {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    }, 60000);
  }

  return {
    ok: true,
    text:
      "已打包 " +
      files.length +
      "/" +
      jobs.length +
      " → " +
      zipName +
      "（后台/无CORS，鉴权:" +
      (authPath || "bearer") +
      ")" +
      (errors.length ? "；失败 " + errors.length : ""),
    okCount: files.length,
    failCount: errors.length,
    authPath: authPath,
  };
}

function handleBatchMessage(msg, tabId, push) {
  push({
    type: "batch-ack",
    requestId: msg.requestId,
    action: "batch-download-bg",
    count: (msg.jobs && msg.jobs.length) || 0,
  });
  return runBatch(msg, tabId, push)
    .then(function (result) {
      push({
        type: "batch-done",
        requestId: msg.requestId,
        ok: true,
        text: result.text,
        authPath: result.authPath,
        okCount: result.okCount,
        failCount: result.failCount,
      });
      return result;
    })
    .catch(function (err) {
      var text = String(err && err.message ? err.message : err);
      push({
        type: "batch-done",
        requestId: msg.requestId,
        ok: false,
        text: text,
      });
      return { ok: false, text: text };
    });
}

// Port path — keeps SW alive for long batches; zip stays in background (no file bytes on sendMessage)
chrome.runtime.onConnect.addListener(function (port) {
  if (!port || port.name !== "a3-batch-qa") return;
  port.onMessage.addListener(function (msg) {
    if (!msg || msg.source !== "a3-batch-qa") return;
    if (msg.type !== "batch-download") return;
    var tabId = port.sender && port.sender.tab && port.sender.tab.id;
    function push(m) {
      try {
        port.postMessage(Object.assign({ source: "a3-batch-qa-bg" }, m));
      } catch (e) {
        /* port gone */
      }
    }
    handleBatchMessage(msg, tabId, push);
  });
});

// Short messages only (ping / legacy)
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.source !== "a3-batch-qa") return;
  if (msg.type === "ping-bg") {
    sendResponse({ ok: true, version: VERSION, portBatch: true });
    return;
  }
  if (msg.type === "batch-download") {
    // Legacy fallback: still supported, but Port is preferred
    var tabId = sender.tab && sender.tab.id;
    function push(m) {
      notifyTab(tabId, Object.assign({ source: "a3-batch-qa-bg" }, m));
    }
    handleBatchMessage(msg, tabId, push).then(function (result) {
      try {
        sendResponse(result);
      } catch (e) {
        /* channel may already be closed — Port/tab notify already sent */
      }
    });
    return true;
  }
});

// For node regress tests (ignored in SW)
try {
  if (typeof globalThis !== "undefined") {
    globalThis.__A3BatchQaBg = {
      VERSION: VERSION,
      buildZip: buildZip,
      downloadUrl: downloadUrl,
      runBatch: runBatch,
      fetchOne: fetchOne,
      formatFetchError: formatFetchError,
    };
  }
} catch (e) {
  /* ignore */
}
