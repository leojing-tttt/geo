importScripts("lib/export-utils.js");

const utils = self.A3GeoExportUtils;

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  return chrome.downloads
    .download({
      url,
      filename,
      saveAs: true
    })
    .finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
}

async function downloadExport({ rows, meta, format }) {
  const names = utils.buildFilenames(meta || {});
  const jobs = [];
  if (format === "csv" || format === "both") {
    jobs.push(
      downloadText(names.csv, utils.toCsv(rows || []), "text/csv;charset=utf-8")
    );
  }
  if (format === "xls" || format === "xlsx" || format === "both") {
    // SpreadsheetML saved as .xls — Excel / WPS open it as a workbook.
    jobs.push(
      downloadText(
        names.xls,
        utils.toSpreadsheetMl(rows || []),
        "application/vnd.ms-excel;charset=utf-8"
      )
    );
  }
  await Promise.all(jobs);
  return { ok: true, filenames: names, count: (rows || []).length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "download-export") {
    downloadExport(msg)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({ ok: false, error: (e && e.message) || String(e) })
      );
    return true;
  }

  if (msg.type === "export-progress") {
    // Popup listens via runtime.onMessage; nothing to do here.
    return;
  }
});
