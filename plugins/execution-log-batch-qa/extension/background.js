/**
 * MV3 service worker — downloads Agent brief txt + STORE zip.
 * Extension host_permissions bypass page CORS (a3-lib → agent.*).
 */
/* eslint-disable no-undef */
"use strict";

var VERSION = "1.0.7";
var VARIANT = "brief";
var PER_FILE_MS = 25000;

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error((label || "请求") + "超时（" + Math.round(ms / 1000) + "s）"));
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

function notifyTab(tabId, msg) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, Object.assign({ source: "a3-batch-qa-bg" }, msg)).catch(function () {});
  } catch (e) {
    /* ignore */
  }
}

async function fetchOne(agentBase, sessionId, bearer) {
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
  } finally {
    clearTimeout(timer);
  }
}

async function runBatch(msg, tabId) {
  var jobs = msg.jobs || [];
  var bearer = String(msg.bearer || "").trim();
  var agentBase = String(msg.agentBase || "").trim();
  var zipName = msg.zipName || "execution-qa.zip";
  var requestId = msg.requestId || "";
  var authPath = msg.authPath || "";

  if (!bearer) throw new Error("缺少 Agent Bearer");
  if (!agentBase) throw new Error("缺少 agentBase");
  if (!jobs.length) throw new Error("没有可下载的会话");

  notifyTab(tabId, {
    type: "batch-status",
    requestId: requestId,
    text: "后台下载启动（扩展绕过 CORS）0/" + jobs.length + " 鉴权:" + (authPath || "bearer"),
  });

  var files = [];
  var errors = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var name = job.fileName || job.sessionId + ".txt";
    notifyTab(tabId, {
      type: "batch-status",
      requestId: requestId,
      text: "后台下载 " + (i + 1) + "/" + jobs.length + " " + name,
    });
    try {
      var data = await fetchOne(agentBase, job.sessionId, bearer);
      files.push({ name: name, data: data });
    } catch (err) {
      var em = String(err && err.message ? err.message : err);
      errors.push(name + ": " + em);
      notifyTab(tabId, {
        type: "batch-status",
        requestId: requestId,
        text: "失败 " + (i + 1) + "/" + jobs.length + " " + em,
        error: true,
      });
    }
  }

  if (!files.length) throw new Error(errors[0] || "全部下载失败");

  notifyTab(tabId, {
    type: "batch-status",
    requestId: requestId,
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

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.source !== "a3-batch-qa") return;
  if (msg.type === "ping-bg") {
    sendResponse({ ok: true, version: VERSION });
    return;
  }
  if (msg.type === "batch-download") {
    var tabId = sender.tab && sender.tab.id;
    notifyTab(tabId, {
      type: "batch-ack",
      requestId: msg.requestId,
      action: "batch-download-bg",
      count: (msg.jobs && msg.jobs.length) || 0,
    });
    runBatch(msg, tabId)
      .then(function (result) {
        notifyTab(tabId, {
          type: "batch-done",
          requestId: msg.requestId,
          ok: true,
          text: result.text,
          authPath: result.authPath,
          okCount: result.okCount,
          failCount: result.failCount,
        });
        sendResponse(result);
      })
      .catch(function (err) {
        var text = String(err && err.message ? err.message : err);
        notifyTab(tabId, {
          type: "batch-done",
          requestId: msg.requestId,
          ok: false,
          text: text,
        });
        sendResponse({ ok: false, text: text });
      });
    return true; // async
  }
});
