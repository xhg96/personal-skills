# 数据 Schema 与 ECharts 作图规范

跨交易所价差分析的标准输出：实时 ECharts 应用（价差 / 资金费率 / 价格对比三图）+ 可分享的独立 HTML 导出。
`assets/echarts-app/` 是该规范的完整参考实现（实时版）：浏览器直连两所 API，配置集中在 `config.js`，优先复制后改配置，不要从零重写。
前端内存中的数据结构与下面的 `spread_data.json` 契约一致；该 JSON 同时是 Python 脚本的输出和导出 HTML 的内嵌快照格式（导出时 `window.__EMBEDDED__` + `window.APP_CONFIG` 引导渲染）。

## 1. spread_data.json 数据契约

由 `scripts/fetch_spread_data.py` 生成（也可作静态快照放在 app 的 `public/` 下）；实时版前端按同一结构在浏览器内组装，`meta` 额外带 `range_start/range_end/interval` 字段。

```jsonc
{
  "generated_at": "2026-10-24 21:43:25 (UTC+8)",
  "meta": {
    "okx_inst": "UNITREE-USDT-SWAP",   // OKX 永续 instId
    "hl_coin": "xyz:UNITREE",          // 主 Hyperliquid 合约（价差/资金费率用它）
    "hl_coin_extra": "para:UNITREE",   // 可选，只用于价格对比图
    "days": 5
  },
  "series": {
    "primary": {
      // 每分钟一点，仅两所都有成交的分钟（inner join，不前向填充）
      // [ts毫秒UTC, OKX收盘价, HL收盘价, 绝对价差USD, 百分比价差%]
      "points": [[1792593540000, 76.7, 76.686, 0.014, 0.0183], ...],
      "mean": 0.0113                    // 绝对价差均值（USD）
    },
    "extra": { "...": "同 primary，可选" }
  },
  "funding": {
    // 资金费率历史，值为小数（0.0001 = 0.01%），前端展示时 ×100
    "okx": [[1792593540000, -0.0031], ...],   // OKX 通常 8h 一次结算
    "primary": [[1792593540000, -0.000012], ...], // HL 每小时一次
    "extra": []
  }
}
```

## 2. 三张图的硬性要求

### 图 1：价差图（主图，最重要）

- **只画一条价差曲线**（OKX − HL primary），不要把两条价格曲线当价差图画。
- 数据映射 `[ts, spreadPct, spreadAbs]`，**纵轴为百分比**，`axisLabel.formatter: "{value}%"`，`scale: true`。
- tooltip 必须同时给出：百分比价差（4 位小数 + `%`）和绝对价差（USD）。
- 辅助线：零轴（实线）+ 百分比均值虚线（均值在客户端对 `points[*][4]` 求平均，不要用绝对均值换算）。
- `showSymbol: false`，线宽 1.2，可配浅色 areaStyle。

### 图 2：资金费率图

- 双 y 轴：**左轴单次结算费率（柱状）**，**右轴累计费率（阶梯虚线，`step: "end"`）**。
- OKX 与 HL 各一根柱 + 一条累计线，共 4 个 series；柱 `barMaxWidth` 区分密度（OKX 8h 柱宽 14，HL 1h 柱宽 5）。
- 累计费率 = 区间内历次结算费率**简单加总**（×100 得 %），明确标注不含复利；正数 = 多头付空头。
- 两所结算频率不同（OKX 通常 8h、HL 1h），不要按条数对齐，按各自真实结算时间画。

### 图 3：价格对比图

- OKX、HL primary、HL extra（如有）三条 1 分钟收盘价线，纵轴 USD，不用百分比刻度。

### 三图缩放联动（容易踩坑）

- **不要依赖 `echarts.connect()` 做缩放同步**——实测多图各自带 dataZoom 时联动不可靠。
- 必须手动同步：监听每张图的 `datazoom` 事件，把当前窗口换算成**绝对时间 startValue/endValue**，再 `dispatchAction` 给其余图（inside 和 slider 两个 dataZoomIndex 都要设），用 `syncing` 标志防止循环。
- 百分比 → 时间的换算基于全局 `DATA_MIN/DATA_MAX`（各序列首末时间的极值）。
- 参考实现见 `assets/echarts-app/main.js` 末尾 `syncZoom()`。

## 3. 视觉规范

暗色 GitHub 风格：背景 `#0d1117`，卡片/图底 `#161b22`，边框 `#30363d`，主文字 `#e6edf3`，次文字 `#8b949e`。
配色：OKX `#58a6ff`（蓝）、HL primary `#f78166`（橙红）、HL extra `#d2a8ff`（紫）。
时间轴统一 UTC+8，格式 `MM-DD HH:mm`；顶部放统计卡片（最新价差 %、最新价、两所累计资金费率）。

## 4. 工程注意

- Vite + echarts 5；`main.js` 用 top-level await，`vite.config.js` 必须 `build.target: "esnext"`，否则 build 报错。
- 每张图 `dataZoom` 都配 `inside` + `slider` 两个组件。
- 数据量大（5 天 ≈ 5000–7000 点/序列）时不要开 symbol 和 smooth。
