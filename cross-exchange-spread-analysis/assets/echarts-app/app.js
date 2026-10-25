/* Classic script (no imports). Uses global window.echarts.
   Booted by main.js (dev) or by the exported standalone HTML. */
window.App = (function () {
  const CONFIG = window.APP_CONFIG || { okx_inst: "UNITREE-USDT-SWAP", hl_coin: "xyz:UNITREE", hl_coin_extra: "para:UNITREE" };
  const COLORS = { okx: "#58a6ff", hl: "#f78166", extra: "#d2a8ff", index: "#3fb950" };
  const MIN = 60000, DAY = 86400000;
  // Hyperliquid 1m history only covers the last few days; coarser intervals
  // go back months. Pick granularity from the requested span.
  const INTERVALS = {
    "1m": { min: 1, okx: "1m", label: "1 分钟" },
    "5m": { min: 5, okx: "5m", label: "5 分钟" },
    "15m": { min: 15, okx: "15m", label: "15 分钟" },
  };
  const chooseInterval = (span) => span <= 4 * DAY ? "1m" : span <= 10 * DAY ? "5m" : "15m";
  let opts = {};
  let current = null;                 // payload: {generated_at, meta, series, funding}
  const state = { mode: "preset", days: 3, customStart: null, customEnd: null };
  let charts = null;

  const $ = (id) => document.getElementById(id);
  const fmtTime = (ts) => {
    const d = new Date(ts + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const status = (t) => { $("status").textContent = t; };

  // ---------- live data (both APIs allow CORS) ----------
  async function fetchJson(url, payload) {
    const RETRIES = 6;
    for (let i = 0; i < RETRIES; i++) {
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(20000),
          ...(payload ? {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          } : {}),
        });
        if (!r.ok) {
          const err = new Error("HTTP " + r.status);
          err.status = r.status;
          err.retryAfter = +r.headers.get("Retry-After") || null;
          throw err;
        }
        return await r.json();
      } catch (e) {
        if (i === RETRIES - 1) throw e;
        if (e.status === 429) status(`触发交易所限流，自动等待重试（第 ${i + 1} 次）…`);
        // 429/5xx get longer exponential backoff with jitter; respect Retry-After
        const base = e.status === 429 || (e.status >= 500) ? 2000 : 1000;
        const wait = e.retryAfter ? e.retryAfter * 1000
          : Math.min(base * Math.pow(1.8, i), 20000) + Math.random() * 500;
        await new Promise(res => setTimeout(res, wait));
      }
    }
  }

  // OKX public market data is rate limited (~20 req / 2s / IP). Serialize request
  // starts with a minimum gap so parallel workers + multiple tabs don't trigger 429.
  let okxChain = Promise.resolve();
  function okxSlot() {
    okxChain = okxChain.then(() => new Promise(r => setTimeout(r, 150)));
    return okxChain;
  }

  // Parallel chunked fetch: each chunk covers <=chunkMin minutes, workers pull
  // chunks concurrently; a runId token lets newer loads supersede stale ones.
  let runId = 0;
  async function parallelChunks(start, end, chunkMin, workers, fn, label) {
    const chunks = [];
    for (let c = start; c < end; c += chunkMin * MIN) chunks.push([c, Math.min(c + chunkMin * MIN, end)]);
    const total = chunks.length;
    let done = 0;
    const id = runId;
    async function worker() {
      while (chunks.length) {
        if (id !== runId) return; // superseded
        const [cs, ce] = chunks.shift();
        await fn(cs, ce);
        done++;
        if (label) status(`${label}：${done}/${total} 段…`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(workers, total) }, worker));
  }

  async function okxCandles(inst, start, end, iv, endpoint = "history-candles") {
    const rows = [];
    // after=<chunkEnd> returns the (up to) 100 newest candles before it
    await parallelChunks(start, end, 100 * iv.min, 4, async (cs, ce) => {
      await okxSlot();
      const d = await fetchJson(`https://www.okx.com/api/v5/market/${endpoint}?instId=${inst}&bar=${iv.okx}&limit=100&after=${ce}`);
      for (const r of d.data || []) rows.push([+r[0], +r[4]]);
    }, `OKX ${iv.label} K 线`);
    return [...new Map(rows.map(r => [r[0], r])).values()]
      .filter(r => r[0] >= start && r[0] < end).sort((a, b) => a[0] - b[0]);
  }

  async function hlCandles(coin, start, end, iv, hlInterval) {
    const rows = [];
    // candleSnapshot caps at 5000 per call; chunks stay under the cap
    await parallelChunks(start, end, 5000 * iv.min, 4, async (cs, ce) => {
      const d = await fetchJson("https://api.hyperliquid.xyz/info",
        { type: "candleSnapshot", req: { coin, interval: hlInterval, startTime: cs, endTime: ce } });
      for (const k of d) rows.push([k.t, +k.c]);
    });
    return [...new Map(rows.map(r => [r[0], r])).values()]
      .filter(r => r[0] >= start && r[0] < end).sort((a, b) => a[0] - b[0]);
  }

  function align(okxRows, hlRows) {
    const hl = new Map(hlRows);
    const points = [];
    for (const [ts, cOkx] of okxRows) {
      if (hl.has(ts)) {
        const cHl = hl.get(ts);
        points.push([ts, +cOkx.toFixed(6), +cHl.toFixed(6), +(cOkx - cHl).toFixed(6), +((cOkx - cHl) / cHl * 100).toFixed(6)]);
      }
    }
    return { points, mean: points.length ? points.reduce((s, p) => s + p[3], 0) / points.length : 0 };
  }

  function resolveRange() {
    if (state.mode === "custom") return { start: state.customStart, end: state.customEnd };
    const end = Date.now();
    return { start: end - state.days * DAY, end };
  }

  // fundingHistory returns the EARLIEST 500 records from startTime -> paginate forward
  async function hlFunding(coin, start, end) {
    const rows = [];
    let cursor = start;
    while (cursor < end) {
      const d = await fetchJson("https://api.hyperliquid.xyz/info",
        { type: "fundingHistory", coin, startTime: cursor, endTime: end });
      if (!d.length) break;
      for (const r of d) rows.push([r.time, +r.fundingRate]);
      const nxt = d[d.length - 1].time + 1;
      if (d.length < 500 || nxt <= cursor) break;
      cursor = nxt;
    }
    return [...new Map(rows.map(r => [r[0], r])).values()]
      .filter(r => r[0] >= start && r[0] <= end).sort((a, b) => a[0] - b[0]);
  }

  // OKX returns the latest 100 settlements -> paginate backwards with `before`
  async function okxFunding(inst, start) {
    const rows = [];
    let before = null;
    while (true) {
      await okxSlot();
      const d = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100${before ? "&before=" + before : ""}`);
      const data = d.data || [];
      if (!data.length) break;
      for (const r of data) rows.push([+r.fundingTime, +r.fundingRate]);
      const oldest = Math.min(...data.map(r => +r.fundingTime));
      if (data.length < 100 || oldest <= start) break;
      before = oldest - 1;
    }
    return rows.filter(r => r[0] >= start).sort((a, b) => a[0] - b[0]);
  }

  async function loadData() {
    const id = ++runId; // latest request wins; stale ones are discarded
    try {
      const { start, end } = resolveRange();
      const interval = chooseInterval(end - start);
      const iv = INTERVALS[interval];
      status(`开始拉取最新数据（${iv.label}粒度）…`);
      const [okx, hlP, hlE, fOkx, fP, fE, idx] = await Promise.all([
        okxCandles(CONFIG.okx_inst, start, end, iv),
        hlCandles(CONFIG.hl_coin, start, end, iv, interval),
        CONFIG.hl_coin_extra ? hlCandles(CONFIG.hl_coin_extra, start, end, iv, interval) : Promise.resolve([]),
        okxFunding(CONFIG.okx_inst, start),
        hlFunding(CONFIG.hl_coin, start, end),
        CONFIG.hl_coin_extra ? hlFunding(CONFIG.hl_coin_extra, start, end) : Promise.resolve([]),
        // OKX index price (e.g. UNITREE-USDT); HL oracle has no public history
        okxCandles(CONFIG.okx_inst.replace("-SWAP", ""), start, end, iv, "index-candles"),
      ]);
      if (id !== runId) return; // a newer range/refresh request superseded this one
      current = {
        generated_at: fmtTime(Date.now()) + " (UTC+8)",
        meta: { ...CONFIG, days: state.mode === "preset" ? state.days : null, range_start: start, range_end: end, interval },
        series: { primary: align(okx, hlP), index: idx },
        funding: { okx: fOkx, primary: fP },
      };
      if (CONFIG.hl_coin_extra) {
        current.series.extra = align(okx, hlE);
        current.funding.extra = fE;
      }
      render(current);
      let msg = `已更新：${current.generated_at}，${iv.label}粒度，对齐 ${current.series.primary.points.length} 根`;
      const first = current.series.primary.points[0]?.[0];
      if (first && first > start + 2 * iv.min * MIN) {
        msg += `；注意：Hyperliquid 最早可用数据为 ${fmtTime(first)}，更早已无该粒度历史`;
      }
      const idxFirst = idx[0]?.[0];
      if (idxFirst && idxFirst > start + 2 * iv.min * MIN) {
        // OKX index-candles keeps only ~1440 candles per interval (rolling)
        msg += `；OKX 指数价格仅覆盖 ${fmtTime(idxFirst)} 之后`;
      }
      status(msg);
    } catch (e) {
      if (id === runId) status("加载失败：" + e.message + "（可点击刷新重试）");
    }
  }

  // ---------- rendering ----------
  const baseAxis = () => ({
    type: "time",
    axisLabel: { color: "#8b949e", formatter: (v) => fmtTime(v) },
    axisLine: { lineStyle: { color: "#30363d" } },
  });
  const baseY = (name, index = 0, pct = true) => ({
    type: "value", name, scale: true, position: index ? "right" : "left",
    nameTextStyle: { color: "#8b949e" },
    axisLabel: { color: "#8b949e", formatter: pct ? "{value}%" : "{value}" },
    axisLine: { show: !!index, lineStyle: { color: "#30363d" } },
    splitLine: { show: !index, lineStyle: { color: "#21262d" } },
  });
  const tooltipBase = {
    trigger: "axis", backgroundColor: "#161b22", borderColor: "#30363d",
    textStyle: { color: "#e6edf3", fontSize: 12 }, axisPointer: { type: "cross" },
  };
  const zoom = () => ([
    { type: "inside", xAxisIndex: 0 },
    { type: "slider", xAxisIndex: 0, height: 24, bottom: 16, borderColor: "#30363d", backgroundColor: "#0d1117", fillerColor: "rgba(88,166,255,0.15)", textStyle: { color: "#8b949e" } },
  ]);
  const title = (t) => ({ text: t, left: 12, top: 6, textStyle: { color: "#e6edf3", fontSize: 14 } });
  const legend = { top: 8, right: 16, textStyle: { color: "#8b949e" } };

  function render(data) {
    const primary = data.series.primary, extra = data.series.extra || null, funding = data.funding;
    const meta = data.meta;
    const OKX = `OKX ${meta.okx_inst}`, HL = `HL ${meta.hl_coin}`;
    const ivLabel = (INTERVALS[meta.interval] || INTERVALS["1m"]).label;
    $("genTime").textContent = data.generated_at;
    $("title").textContent = `${meta.okx_inst} 跨交易所价差（${ivLabel}）`;
    $("subtitle").textContent = `${OKX} vs Hyperliquid ${meta.hl_coin}${meta.hl_coin_extra ? " / " + meta.hl_coin_extra : ""}`;

    const last = primary.points.at(-1);
    const cum = (rows) => rows.reduce((s, r) => s + r[1], 0) * 100;
    const cards = [
      { label: `${OKX} − ${HL} 最新价差`, value: last ? `${last[4].toFixed(3)}%` : "—", extra: last ? `绝对价差 ${last[3].toFixed(4)} USD` : "无对齐数据" },
      { label: "OKX 最新价 (USDT)", value: last ? last[1].toFixed(3) : "—", extra: last ? `${HL} ${last[2].toFixed(3)} USDC` : "" },
      { label: "OKX 累计资金费率", value: `${cum(funding.okx).toFixed(3)}%`, extra: `${funding.okx.length} 次结算` },
      { label: `${HL} 累计资金费率`, value: `${cum(funding.primary).toFixed(3)}%`, extra: `${funding.primary.length} 次结算` },
    ];
    $("cards").innerHTML = cards.map(c =>
      `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="extra">${c.extra}</div></div>`).join("");

    if (!charts) {
      charts = {
        spread: echarts.init($("spreadChart")),
        funding: echarts.init($("fundingChart")),
        price: echarts.init($("priceChart")),
      };
      bindZoomSync();
      window.addEventListener("resize", () => Object.values(charts).forEach(c => c.resize()));
    }

    charts.spread.setOption({
      backgroundColor: "transparent",
      title: title(`价差：${OKX} − ${HL}（${ivLabel}收盘价）`),
      grid: { left: 70, right: 30, top: 50, bottom: 70 },
      tooltip: {
        ...tooltipBase,
        formatter: (params) => {
          if (!params.length) return "";
          const [ts, pct, abs] = params[0].value;
          return `<b>${fmtTime(ts)}</b><br/>${params[0].marker}百分比价差：<b>${pct.toFixed(4)}%</b><br/>${params[0].marker}绝对价差：<b>${abs.toFixed(4)}</b> USD`;
        },
      },
      xAxis: baseAxis(), yAxis: baseY("价差 (%)"), dataZoom: zoom(),
      series: [{
        name: "价差", type: "line", showSymbol: false,
        lineStyle: { width: 1.2, color: COLORS.hl }, itemStyle: { color: COLORS.hl },
        areaStyle: { color: "rgba(247,129,102,0.08)" },
        data: primary.points.map(p => [p[0], p[4], p[3]]),
        markLine: {
          silent: true, symbol: "none", lineStyle: { type: "dashed", color: "#8b949e" }, label: { color: "#8b949e" },
          data: primary.points.length ? [
            { yAxis: primary.points.reduce((s, p) => s + p[4], 0) / primary.points.length, label: { formatter: "均值", color: "#8b949e" } },
            { yAxis: 0, lineStyle: { color: "#484f58", type: "solid" }, label: { show: false } },
          ] : [],
        },
      }],
    }, true);

    const fs = (rows) => {
      let acc = 0; const single = [], cumulative = [];
      for (const [ts, rate] of rows) { acc += rate * 100; single.push([ts, rate * 100]); cumulative.push([ts, acc]); }
      return { single, cumulative };
    };
    const fOkx = fs(funding.okx), fHl = fs(funding.primary);
    charts.funding.setOption({
      backgroundColor: "transparent",
      title: title("资金费率：单次结算费率（柱，左轴）+ 累计费率（线，右轴）"),
      legend,
      grid: { left: 70, right: 70, top: 50, bottom: 70 },
      tooltip: {
        ...tooltipBase,
        formatter: (params) => {
          if (!params.length) return "";
          let html = `<b>${fmtTime(params[0].value[0])}</b>`;
          for (const p of params) html += `<br/>${p.marker}${p.seriesName}：<b>${p.value[1].toFixed(4)}%</b>`;
          return html;
        },
      },
      xAxis: baseAxis(), yAxis: [baseY("单次费率 (%)"), baseY("累计费率 (%)", 1)], dataZoom: zoom(),
      series: [
        { name: "OKX 单次结算", type: "bar", barMaxWidth: 14, itemStyle: { color: COLORS.okx }, data: fOkx.single },
        { name: `${HL} 单次结算`, type: "bar", barMaxWidth: 5, itemStyle: { color: COLORS.hl }, data: fHl.single },
        { name: "OKX 累计费率", type: "line", yAxisIndex: 1, showSymbol: true, symbolSize: 4, step: "end", lineStyle: { width: 1.6, color: COLORS.okx, type: "dashed" }, itemStyle: { color: COLORS.okx }, data: fOkx.cumulative },
        { name: `${HL} 累计费率`, type: "line", yAxisIndex: 1, showSymbol: false, step: "end", lineStyle: { width: 1.6, color: COLORS.hl, type: "dashed" }, itemStyle: { color: COLORS.hl }, data: fHl.cumulative },
      ],
    }, true);

    const priceSeries = [
      { name: OKX, type: "line", showSymbol: false, lineStyle: { width: 1.2, color: COLORS.okx }, itemStyle: { color: COLORS.okx }, data: primary.points.map(p => [p[0], p[1]]) },
      { name: HL, type: "line", showSymbol: false, lineStyle: { width: 1.2, color: COLORS.hl }, itemStyle: { color: COLORS.hl }, data: primary.points.map(p => [p[0], p[2]]) },
    ];
    if (extra) priceSeries.push({ name: `HL ${meta.hl_coin_extra}`, type: "line", showSymbol: false, lineStyle: { width: 1.2, color: COLORS.extra }, itemStyle: { color: COLORS.extra }, data: extra.points.map(p => [p[0], p[2]]) });
    if (data.series.index?.length) priceSeries.push({
      name: `OKX 指数价格（${meta.okx_inst.replace("-SWAP", "")}）`, type: "line", showSymbol: false,
      lineStyle: { width: 1, color: COLORS.index, type: "dashed" }, itemStyle: { color: COLORS.index },
      data: data.series.index,
    });
    charts.price.setOption({
      backgroundColor: "transparent",
      title: title(`价格对比（${ivLabel}收盘价）`), legend,
      grid: { left: 70, right: 30, top: 50, bottom: 70 },
      tooltip: {
        ...tooltipBase,
        formatter: (params) => {
          if (!params.length) return "";
          let html = `<b>${fmtTime(params[0].value[0])}</b>`;
          for (const p of params) html += `<br/>${p.marker}${p.seriesName}：<b>${p.value[1].toFixed(3)}</b>`;
          return html;
        },
      },
      xAxis: baseAxis(), yAxis: baseY("价格 (USD)", 0, false), dataZoom: zoom(),
      series: priceSeries,
    }, true);
  }

  // ---------- zoom sync by absolute time window ----------
  function bindZoomSync() {
    const list = Object.values(charts);
    let syncing = false;
    const domain = () => {
      const p = current.series.primary.points;
      const f = [...current.funding.okx, ...current.funding.primary];
      return [Math.min(p[0]?.[0] ?? Infinity, ...f.map(r => r[0])), Math.max(p.at(-1)?.[0] ?? 0, ...f.map(r => r[0]))];
    };
    for (const source of list) {
      source.on("datazoom", () => {
        if (syncing) return;
        const z = source.getOption().dataZoom[0];
        const [dMin, dMax] = domain();
        let startValue = z.startValue, endValue = z.endValue;
        if (startValue == null || endValue == null) {
          startValue = dMin + (z.start / 100) * (dMax - dMin);
          endValue = dMin + (z.end / 100) * (dMax - dMin);
        }
        syncing = true;
        for (const c of list) {
          if (c === source) continue;
          c.dispatchAction({ type: "dataZoom", batch: [{ dataZoomIndex: 0, startValue, endValue }, { dataZoomIndex: 1, startValue, endValue }] });
        }
        syncing = false;
      });
    }
  }

  // ---------- standalone HTML export ----------
  function exportHtml() {
    if (!current || !opts.appSource) return;
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script").forEach(s => s.remove());
    clone.querySelectorAll(".chart").forEach(d => { d.innerHTML = ""; });
    const st = clone.querySelector("#status"); if (st) st.textContent = "本文件为 " + current.generated_at + " 的数据快照；刷新与切换范围需要联网。";
    const boot = `<script>${opts.echartsRaw}<\/script>\n`
      + `<script>window.__EMBEDDED__=${JSON.stringify(current)};window.APP_CONFIG=${JSON.stringify(CONFIG)};<\/script>\n`
      + `<script>${opts.appSource}<\/script>\n`
      + `<script>window.App.init({embedded:window.__EMBEDDED__});<\/script>`;
    const html = "<!DOCTYPE html>\n" + clone.outerHTML.replace("</body>", boot + "\n</body>");
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${CONFIG.okx_inst}-spread-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- UI ----------
  function bindUI() {
    document.querySelectorAll(".range-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        state.mode = "preset";
        state.days = +btn.dataset.days;
        document.querySelectorAll(".range-btn").forEach(b => b.classList.toggle("active", b === btn));
        loadData();
      });
    });
    $("customApply").addEventListener("click", () => {
      const s = $("customStart").value, e = $("customEnd").value;
      if (!s || !e) { status("请先选择起止时间（按 UTC+8 填写）"); return; }
      const start = Date.parse(s + "+08:00"), end = Date.parse(e + "+08:00");
      if (!(start < end)) { status("起始时间必须早于结束时间"); return; }
      state.mode = "custom"; state.customStart = start; state.customEnd = end;
      document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
      loadData();
    });
    $("refreshBtn").addEventListener("click", loadData);
    if (opts.appSource) $("exportBtn").addEventListener("click", exportHtml);
    else $("exportBtn").style.display = "none";
  }

  async function init(options) {
    opts = options || {};
    bindUI();
    if (opts.embedded) {
      current = opts.embedded;
      if (current.meta.days) {
        state.days = current.meta.days;
        document.querySelectorAll(".range-btn").forEach(b => b.classList.toggle("active", +b.dataset.days === state.days));
      }
      render(current);
      status("数据快照：" + current.generated_at + "；点击刷新或切换范围可拉取最新行情");
    } else {
      await loadData();
    }
  }

  return { init };
})();
