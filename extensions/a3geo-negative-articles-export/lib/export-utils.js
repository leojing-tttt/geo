/**
 * Shared CSV / Excel helpers. Safe for content script + service worker.
 */
(function (root, factory) {
  var api = factory();
  root.A3GeoExportUtils = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var COLUMNS = [
    { key: "title", label: "文章名称" },
    { key: "publish_time", label: "发布时间" },
    { key: "site_name", label: "发布站点" },
    { key: "domain_name", label: "站点域名" },
    { key: "category", label: "站点类型" },
    { key: "negative_mentions_count", label: "文章负面词" },
    { key: "platform_count", label: "引用AI平台数" },
    { key: "platforms", label: "引用AI平台" },
    { key: "prompt_count", label: "引用AI问题数" },
    { key: "article_quote_count", label: "引用次数" },
    { key: "url", label: "原文链接" },
    { key: "source_id", label: "文章ID" }
  ];

  function cellValue(row, key) {
    var v = row[key];
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(",");
    return String(v);
  }

  function escapeCsv(value) {
    var s = String(value == null ? "" : value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    var header = COLUMNS.map(function (c) {
      return escapeCsv(c.label);
    }).join(",");
    var lines = (rows || []).map(function (row) {
      return COLUMNS.map(function (c) {
        return escapeCsv(cellValue(row, c.key));
      }).join(",");
    });
    return "\uFEFF" + [header].concat(lines).join("\r\n");
  }

  function xmlEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toSpreadsheetMl(rows) {
    var header = COLUMNS.map(function (c) {
      return (
        "<Cell><Data ss:Type=\"String\">" +
        xmlEscape(c.label) +
        "</Data></Cell>"
      );
    }).join("");
    var body = (rows || [])
      .map(function (row) {
        var cells = COLUMNS.map(function (c) {
          var raw = cellValue(row, c.key);
          var isNum =
            raw !== "" &&
            !isNaN(Number(raw)) &&
            /^-?\d+(\.\d+)?$/.test(raw);
          var type = isNum ? "Number" : "String";
          return (
            "<Cell><Data ss:Type=\"" +
            type +
            "\">" +
            xmlEscape(raw) +
            "</Data></Cell>"
          );
        }).join("");
        return "<Row>" + cells + "</Row>";
      })
      .join("");
    return (
      '<?xml version="1.0"?>\r\n' +
      '<?mso-application progid="Excel.Sheet"?>\r\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\r\n' +
      ' xmlns:o="urn:schemas-microsoft-com:office:office"\r\n' +
      ' xmlns:x="urn:schemas-microsoft-com:office:excel"\r\n' +
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\r\n' +
      ' xmlns:html="http://www.w3.org/TR/REC-html40">\r\n' +
      '<Worksheet ss:Name="negative-articles">\r\n' +
      "<Table>\r\n" +
      "<Row>" +
      header +
      "</Row>\r\n" +
      body +
      "\r\n</Table>\r\n</Worksheet>\r\n</Workbook>"
    );
  }

  function stamp() {
    var d = new Date();
    function p(n) {
      return String(n).padStart(2, "0");
    }
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    );
  }

  function buildFilenames(meta) {
    var brand = (meta && meta.brandLabel) || "brand";
    var safe = String(brand)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "")
      .slice(0, 40);
    // Keep an ASCII-friendly prefix so Chrome download never silently drops the file.
    var t = stamp();
    return {
      csv: "a3geo-negative-" + safe + "-" + t + ".csv",
      xls: "a3geo-negative-" + safe + "-" + t + ".xls"
    };
  }

  function triggerBrowserDownload(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 30_000);
  }

  function downloadRows(rows, meta, format) {
    var names = buildFilenames(meta || {});
    var fmt = format || "both";
    if (fmt === "csv" || fmt === "both") {
      triggerBrowserDownload(
        names.csv,
        toCsv(rows || []),
        "text/csv;charset=utf-8"
      );
    }
    if (fmt === "xls" || fmt === "xlsx" || fmt === "both") {
      triggerBrowserDownload(
        names.xls,
        toSpreadsheetMl(rows || []),
        "application/vnd.ms-excel;charset=utf-8"
      );
    }
    return { ok: true, filenames: names, count: (rows || []).length };
  }

  return {
    COLUMNS: COLUMNS,
    toCsv: toCsv,
    toSpreadsheetMl: toSpreadsheetMl,
    buildFilenames: buildFilenames,
    downloadRows: downloadRows,
    triggerBrowserDownload: triggerBrowserDownload
  };
});
