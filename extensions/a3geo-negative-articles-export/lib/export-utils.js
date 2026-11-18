/**
 * Shared CSV / simple XLSX helpers (no third-party runtime deps).
 * Used by the extension popup/background download path.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.A3GeoExportUtils = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const COLUMNS = [
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
    const v = row[key];
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(",");
    return String(v);
  }

  function escapeCsv(value) {
    const s = String(value ?? "");
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toCsv(rows) {
    const header = COLUMNS.map((c) => escapeCsv(c.label)).join(",");
    const lines = rows.map((row) =>
      COLUMNS.map((c) => escapeCsv(cellValue(row, c.key))).join(",")
    );
    // UTF-8 BOM so Excel opens Chinese correctly
    return "\uFEFF" + [header, ...lines].join("\r\n");
  }

  function xmlEscape(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** SpreadsheetML (.xls) — opens natively in Excel / WPS without SheetJS. */
  function toSpreadsheetMl(rows) {
    const header = COLUMNS.map(
      (c) => `<Cell><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`
    ).join("");
    const body = rows
      .map((row) => {
        const cells = COLUMNS.map((c) => {
          const raw = cellValue(row, c.key);
          const isNum =
            raw !== "" &&
            !Number.isNaN(Number(raw)) &&
            /^-?\d+(\.\d+)?$/.test(raw);
          const type = isNum ? "Number" : "String";
          return `<Cell><Data ss:Type="${type}">${xmlEscape(raw)}</Data></Cell>`;
        }).join("");
        return `<Row>${cells}</Row>`;
      })
      .join("");
    return (
      `<?xml version="1.0"?>\r\n` +
      `<?mso-application progid="Excel.Sheet"?>\r\n` +
      `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\r\n` +
      ` xmlns:o="urn:schemas-microsoft-com:office:office"\r\n` +
      ` xmlns:x="urn:schemas-microsoft-com:office:excel"\r\n` +
      ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\r\n` +
      ` xmlns:html="http://www.w3.org/TR/REC-html40">\r\n` +
      `<Worksheet ss:Name="全部负面文章">\r\n` +
      `<Table>\r\n` +
      `<Row>${header}</Row>\r\n` +
      `${body}\r\n` +
      `</Table>\r\n` +
      `</Worksheet>\r\n` +
      `</Workbook>`
    );
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
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
    const brand = (meta && meta.brandLabel) || "brand";
    const safe = String(brand).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40);
    const t = stamp();
    return {
      csv: `A3GEO-负面文章-${safe}-${t}.csv`,
      xls: `A3GEO-负面文章-${safe}-${t}.xls`
    };
  }

  return { COLUMNS, toCsv, toSpreadsheetMl, buildFilenames, cellValue };
});
