/**
 * Runs in the page MAIN world so it can reuse A3GEO's request signing
 * (window.he / window.sh) and read the current Vue filter state.
 */
(function () {
  if (window.__A3GEO_NEG_EXPORT_INJECTED__) return;
  window.__A3GEO_NEG_EXPORT_INJECTED__ = true;

  const API_BASE = "https://api.aidso.com";
  const RANK_PATH = "/dso/api/geo/resource/negative_article_rank";
  const EVENT_REQ = "a3geo-neg-export-request";
  const EVENT_RES = "a3geo-neg-export-result";

  function reply(payload) {
    window.dispatchEvent(new CustomEvent(EVENT_RES, { detail: payload }));
  }

  function getToken() {
    try {
      return JSON.parse(localStorage.getItem("token"));
    } catch (e) {
      return localStorage.getItem("token");
    }
  }

  function ensureSigningReady() {
    if (typeof window.he !== "function" || typeof window.sh !== "function") {
      throw new Error("页面签名脚本未就绪，请刷新后重试");
    }
  }

  async function signedPost(path, body) {
    ensureSigningReady();
    let url = API_BASE + path;
    localStorage.removeItem("dt");
    const ts = Date.now() + 1 * (Number(sessionStorage.getItem("diffDate")) || 0);
    const pathPart = url.split(API_BASE)[1];
    const token = getToken();
    localStorage.setItem("dt", String(ts));
    const he = window.he(token ? "uid" : "dt");
    const sign = window.sh(pathPart + ts);
    // Match site interceptor: do NOT encodeURIComponent(he)
    url = url + "?ts=" + ts + "&he=" + he + "&sign=" + sign;
    const headers = {
      "Content-Type": "application/json",
      "d-t": String(ts)
    };
    if (token) headers.Authorization = token;
    try {
      headers["d-v"] = btoa(window.v() + "," + window.hi("dt"));
    } catch (e) {
      /* optional anti-bot header */
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function walkVue(vm, pred, depth) {
    if (!vm || depth > 40) return null;
    try {
      if (pred(vm)) return vm;
    } catch (e) {
      /* ignore */
    }
    const children = vm.$children || [];
    for (let i = 0; i < children.length; i++) {
      const found = walkVue(children[i], pred, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function getRootVue() {
    const el = document.querySelector("#app");
    return el && el.__vue__ ? el.__vue__ : null;
  }

  function normalizeDateBound(value, endOfDay) {
    if (value == null || value === "") return value;
    if (typeof value === "number") {
      // Defensive: numeric yyyymmdd was mis-parsed by API as epoch; convert.
      const s = String(value);
      if (/^\d{8}$/.test(s)) {
        const iso =
          s.slice(0, 4) +
          "-" +
          s.slice(4, 6) +
          "-" +
          s.slice(6, 8) +
          (endOfDay ? " 23:59:59" : " 00:00:00");
        return iso;
      }
      return value;
    }
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return s + (endOfDay ? " 23:59:59" : " 00:00:00");
    }
    if (/^\d{8}$/.test(s)) {
      return (
        s.slice(0, 4) +
        "-" +
        s.slice(4, 6) +
        "-" +
        s.slice(6, 8) +
        (endOfDay ? " 23:59:59" : " 00:00:00")
      );
    }
    return s;
  }

  function clearUndefined(obj) {
    const out = Object.assign({}, obj);
    Object.keys(out).forEach((k) => {
      if (out[k] === undefined) delete out[k];
    });
    return out;
  }

  function collectParamsFromPage() {
    const root = getRootVue();
    if (!root || !root.$store) {
      throw new Error("未找到页面状态，请确认已打开 A3GEO 且页面加载完成");
    }
    const store = root.$store;
    if (!store.state.token && !getToken()) {
      throw new Error("未登录：请先在本浏览器登录 geo.a3database.cn");
    }

    const brandPage = walkVue(
      root,
      (vm) => vm.$options && vm.$options.name === "BrandSentiment",
      0
    );

    let params = null;
    let brandLabel = "";

    if (brandPage && typeof brandPage.getParams === "function") {
      params = clearUndefined(brandPage.getParams() || {});
      if (brandPage.lastParams && Object.keys(brandPage.lastParams).length) {
        params = clearUndefined(
          Object.assign({}, brandPage.lastParams, params)
        );
      }
    }

    const negSection = walkVue(
      root,
      (vm) => vm.$options && vm.$options.name === "NegativeSentimentSection",
      0
    );
    if (
      (!params || !params.brand_library_id) &&
      negSection &&
      negSection.currentParams
    ) {
      params = clearUndefined(Object.assign({}, negSection.currentParams));
    }

    if (!params || !params.brand_library_id) {
      const brandId = store.state.selectedBrandId;
      if (!brandId) {
        throw new Error("请先在页面选择监测品牌/计划，并等待数据加载");
      }
      params = { brand_library_id: brandId };
    }

    if (params.begin_time != null) {
      params.begin_time = normalizeDateBound(params.begin_time, false);
    }
    if (params.end_time != null) {
      params.end_time = normalizeDateBound(params.end_time, true);
    }

    if (!params.begin_time || !params.end_time) {
      throw new Error("缺少日期范围：请在舆情页选择开始/结束日期后再导出");
    }

    const brands = store.state.brandList || [];
    const hit = brands.find(
      (b) => String(b.value || b.id) === String(params.brand_library_id)
    );
    if (hit) {
      brandLabel = hit.label || hit.brand_name || hit.plan_name || "";
      if (hit.brand_name && hit.plan_name) {
        brandLabel = hit.brand_name + "-" + hit.plan_name;
      }
    }

    return {
      params_data: clearUndefined(params),
      brandLabel: brandLabel || String(params.brand_library_id),
      path: location.pathname
    };
  }

  async function fetchAllNegativeArticles(paramsData, onProgress) {
    const pageSize = 100;
    let pageNo = 1;
    let total = Infinity;
    const all = [];

    while (all.length < total) {
      const body = {
        page_no: pageNo,
        page_size: pageSize,
        params_data: paramsData
      };
      const res = await signedPost(RANK_PATH, body);
      if (!res || res.code !== 200) {
        const msg = (res && (res.msg || res.message)) || "接口返回异常";
        throw new Error("拉取失败（" + (res && res.code) + "）：" + msg);
      }
      const rows = (res.data && res.data.result) || [];
      total = Number(
        (res.data && res.data.total_record) != null
          ? res.data.total_record
          : rows.length
      );
      all.push.apply(all, rows);
      if (typeof onProgress === "function") {
        onProgress({
          fetched: all.length,
          total: Number.isFinite(total) ? total : all.length,
          page: pageNo
        });
      }
      if (!rows.length) break;
      pageNo += 1;
      if (pageNo > 200) {
        throw new Error("分页超过上限，已中止（请缩小日期范围后重试）");
      }
    }
    return { rows: all, total: all.length };
  }

  async function handleExport(detail) {
    try {
      if (!location.pathname.includes("/monitor/sentiment")) {
        throw new Error(
          "请先打开「品牌监测 → 品牌舆情追踪」页面：/monitor/sentiment"
        );
      }
      const collected = collectParamsFromPage();
      reply({
        type: "progress",
        message: "正在按当前筛选拉取全部负面文章…",
        meta: collected
      });
      const { rows, total } = await fetchAllNegativeArticles(
        collected.params_data,
        (p) => {
          reply({
            type: "progress",
            message: `已获取 ${p.fetched}/${p.total} 条…`,
            progress: p
          });
        }
      );
      reply({
        type: "done",
        rows,
        total,
        meta: collected,
        format: (detail && detail.format) || "both",
        source: (detail && detail.source) || "popup"
      });
    } catch (err) {
      reply({
        type: "error",
        message: (err && err.message) || String(err)
      });
    }
  }

  window.addEventListener(EVENT_REQ, (ev) => {
    handleExport((ev && ev.detail) || {});
  });

  // Optional floating button on sentiment page
  function ensureFab() {
    if (!location.pathname.includes("/monitor/sentiment")) return;
    if (document.getElementById("a3geo-neg-export-fab")) return;
    const btn = document.createElement("button");
    btn.id = "a3geo-neg-export-fab";
    btn.type = "button";
    btn.textContent = "导出全部负面文章";
    Object.assign(btn.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483646",
      padding: "10px 14px",
      borderRadius: "8px",
      border: "none",
      cursor: "pointer",
      background: "#16786e",
      color: "#fff",
      fontSize: "13px",
      boxShadow: "0 4px 14px rgba(0,0,0,.18)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "导出中…";
      const onDone = (ev) => {
        const d = ev.detail || {};
        if (d.type === "progress") {
          btn.textContent = d.message || "导出中…";
          return;
        }
        window.removeEventListener(EVENT_RES, onDone);
        btn.disabled = false;
        btn.textContent = "导出全部负面文章";
      };
      window.addEventListener(EVENT_RES, onDone);
      window.dispatchEvent(
        new CustomEvent(EVENT_REQ, { detail: { format: "both", source: "fab" } })
      );
    });
    document.documentElement.appendChild(btn);
  }

  ensureFab();
  const mo = new MutationObserver(() => ensureFab());
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
