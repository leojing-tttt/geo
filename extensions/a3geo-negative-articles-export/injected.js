/**
 * MAIN world: reuse page signing + Vue filter state.
 * Talks to content script via window.postMessage.
 */
(function () {
  if (window.__A3GEO_NEG_EXPORT_INJECTED__) {
    window.dispatchEvent(new Event("a3geo-neg-export-ready"));
    return;
  }
  window.__A3GEO_NEG_EXPORT_INJECTED__ = true;

  var API_BASE = "https://api.aidso.com";
  var RANK_PATH = "/dso/api/geo/resource/negative_article_rank";
  var SOURCE = "a3geo-neg-export";
  var busy = false;

  function post(payload) {
    window.postMessage(
      Object.assign({ source: SOURCE, direction: "from-page" }, payload),
      "*"
    );
  }

  function toast(message, isError) {
    var id = "a3geo-neg-export-toast";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "88px",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        maxWidth: "86vw",
        padding: "10px 14px",
        borderRadius: "8px",
        color: "#fff",
        fontSize: "13px",
        lineHeight: "1.4",
        boxShadow: "0 8px 24px rgba(0,0,0,.2)",
        fontFamily: "system-ui,-apple-system,sans-serif"
      });
      document.documentElement.appendChild(el);
    }
    el.style.background = isError ? "#b42318" : "#16786e";
    el.textContent = message;
    clearTimeout(el.__timer);
    el.__timer = setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, isError ? 8000 : 4000);
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
      throw new Error("页面签名脚本未就绪，请刷新舆情页后重试");
    }
  }

  async function signedPost(path, body) {
    ensureSigningReady();
    var url = API_BASE + path;
    localStorage.removeItem("dt");
    var ts = Date.now() + 1 * (Number(sessionStorage.getItem("diffDate")) || 0);
    var pathPart = url.split(API_BASE)[1];
    var token = getToken();
    localStorage.setItem("dt", String(ts));
    var he = window.he(token ? "uid" : "dt");
    var sign = window.sh(pathPart + ts);
    url = url + "?ts=" + ts + "&he=" + he + "&sign=" + sign;
    var headers = {
      "Content-Type": "application/json",
      "d-t": String(ts)
    };
    if (token) headers.Authorization = token;
    try {
      headers["d-v"] = btoa(window.v() + "," + window.hi("dt"));
    } catch (e) {}
    var res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function walkVue(vm, pred, depth) {
    if (!vm || depth > 50) return null;
    try {
      if (pred(vm)) return vm;
    } catch (e) {}
    var children = vm.$children || [];
    for (var i = 0; i < children.length; i++) {
      var found = walkVue(children[i], pred, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function getRootVue() {
    var el = document.querySelector("#app");
    return el && el.__vue__ ? el.__vue__ : null;
  }

  function normalizeDateBound(value, endOfDay) {
    if (value == null || value === "") return value;
    if (typeof value === "number") {
      var ns = String(value);
      if (/^\d{8}$/.test(ns)) {
        return (
          ns.slice(0, 4) +
          "-" +
          ns.slice(4, 6) +
          "-" +
          ns.slice(6, 8) +
          (endOfDay ? " 23:59:59" : " 00:00:00")
        );
      }
      return value;
    }
    var s = String(value).trim();
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
    var out = Object.assign({}, obj);
    Object.keys(out).forEach(function (k) {
      if (out[k] === undefined) delete out[k];
    });
    return out;
  }

  function collectParamsFromPage() {
    var root = getRootVue();
    if (!root || !root.$store) {
      throw new Error("未找到页面状态，请确认已打开 A3GEO 且页面加载完成");
    }
    var store = root.$store;
    if (!store.state.token && !getToken()) {
      throw new Error("未登录：请先登录 geo.a3database.cn");
    }

    var brandPage = walkVue(
      root,
      function (vm) {
        return vm.$options && vm.$options.name === "BrandSentiment";
      },
      0
    );

    var params = null;
    var brandLabel = "";

    if (brandPage && typeof brandPage.getParams === "function") {
      params = clearUndefined(brandPage.getParams() || {});
      if (brandPage.lastParams && Object.keys(brandPage.lastParams).length) {
        params = clearUndefined(
          Object.assign({}, brandPage.lastParams, params)
        );
      }
    }

    var negSection = walkVue(
      root,
      function (vm) {
        return vm.$options && vm.$options.name === "NegativeSentimentSection";
      },
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
      var brandId = store.state.selectedBrandId;
      if (!brandId) {
        throw new Error("请先选择监测品牌/计划，并等待数据加载完成");
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
      throw new Error("缺少日期范围：请先在顶部选择开始/结束日期");
    }

    var brands = store.state.brandList || [];
    var hit = brands.find(function (b) {
      return String(b.value || b.id) === String(params.brand_library_id);
    });
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

  async function fetchAllNegativeArticles(paramsData) {
    var pageSize = 100;
    var pageNo = 1;
    var total = Infinity;
    var all = [];

    while (all.length < total) {
      var res = await signedPost(RANK_PATH, {
        page_no: pageNo,
        page_size: pageSize,
        params_data: paramsData
      });
      if (!res || res.code !== 200) {
        var msg = (res && (res.msg || res.message)) || "接口返回异常";
        throw new Error("拉取失败（" + (res && res.code) + "）：" + msg);
      }
      var rows = (res.data && res.data.result) || [];
      total = Number(
        res.data && res.data.total_record != null
          ? res.data.total_record
          : rows.length
      );
      for (var i = 0; i < rows.length; i++) all.push(rows[i]);
      post({
        type: "progress",
        message: "已获取 " + all.length + "/" + (Number.isFinite(total) ? total : all.length) + " 条…"
      });
      if (!rows.length) break;
      pageNo += 1;
      if (pageNo > 200) {
        throw new Error("分页超过上限，请缩小日期范围后重试");
      }
    }
    return { rows: all, total: all.length };
  }

  async function handleExport(detail) {
    if (busy) {
      toast("已有导出任务进行中", true);
      return;
    }
    busy = true;
    setFabBusy(true, "导出中…");
    try {
      if (!/\/monitor\/sentiment/.test(location.pathname)) {
        throw new Error("请先打开「品牌监测 → 品牌舆情追踪」页面");
      }
      var collected = collectParamsFromPage();
      post({
        type: "progress",
        message: "正在按当前筛选拉取全部负面文章…"
      });
      toast("正在导出，请稍候…", false);
      var result = await fetchAllNegativeArticles(collected.params_data);
      post({
        type: "done",
        rows: result.rows,
        total: result.total,
        meta: collected,
        format: (detail && detail.format) || "both",
        source: (detail && detail.source) || "popup"
      });
    } catch (err) {
      var message = (err && err.message) || String(err);
      toast(message, true);
      post({ type: "error", message: message });
    } finally {
      busy = false;
      setFabBusy(false);
    }
  }

  function setFabBusy(isBusy, text) {
    var btn = document.getElementById("a3geo-neg-export-fab");
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.textContent = isBusy ? text || "导出中…" : "导出全部负面文章";
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.source !== SOURCE || data.direction !== "to-page") return;
    if (data.type === "export") {
      handleExport(data);
    }
  });

  function ensureFab() {
    if (!/\/monitor\/sentiment/.test(location.pathname)) return;
    if (document.getElementById("a3geo-neg-export-fab")) return;
    var btn = document.createElement("button");
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
      fontFamily: "system-ui,-apple-system,sans-serif"
    });
    btn.addEventListener("click", function () {
      handleExport({ format: "both", source: "fab" });
    });
    document.documentElement.appendChild(btn);
  }

  ensureFab();
  var mo = new MutationObserver(function () {
    ensureFab();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.dispatchEvent(new Event("a3geo-neg-export-ready"));
})();
