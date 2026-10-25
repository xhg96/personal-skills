---
name: cross-exchange-spread-analysis
description: 跨交易所永续合约价差与资金费率分析：拉取 OKX（USDT 永续）与 Hyperliquid（USDC 永续，含 xyz:/para: 等 HIP-3 dex）的分钟K线和资金费率历史，按分钟收盘价对齐计算绝对/百分比价差，并用标准 ECharts 三图（单条百分比价差曲线、单次+累计资金费率、价格对比、绝对时间联动缩放）展示。用于"对比两个所某合约价差""画 OKX 和 Hyperliquid 的价差/资金费率""跨所套利价差监控"等请求，精确到分钟、最近 N 天的场景。
---

# 跨交易所价差分析

## 工作流程

### 1. 确认合约真实代码（不要猜）

- OKX：`GET https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=<BASE>-USDT-SWAP`，`data` 非空才存在。
- Hyperliquid 主站：`POST https://api.hyperliquid.xyz/info`，`{"type":"meta"}` 查 `universe[].name`。
- 主站没有时查 HIP-3 builder dex：先 `{"type":"perpDexs"}` 拿 dex 列表，再逐个 `{"type":"meta","dex":"<dex>"}`；命中的合约名形如 `xyz:UNITREE`，后续 API 的 `coin` 参数必须用带前缀的全名。
- 若同一币种在多个 dex 都有（如 xyz 和 para），选流动性好的为主合约，另一个可作 `--hl-coin-extra`；用户没指明时在答复里说明选择。

### 2. 拉数据（用脚本，不要手翻 API 分页）

**先读 `references/api-notes.md`**：两所接口的分页方向、500/100 条上限、HL 1m 历史保留期等实测限制，踩坑前必看。

```bash
python3 scripts/fetch_spread_data.py \
  --okx-inst UNITREE-USDT-SWAP --hl-coin xyz:UNITREE \
  --hl-coin-extra para:UNITREE --days 5 \
  --out <app>/public/spread_data.json --csv-dir .
```

脚本封装了这些已验证的细节：OKX `history-candles` 每页 100 根向回翻页且**必须带浏览器 UA**（默认 python UA 返回 403）；HL `candleSnapshot` 每页 ≤5000 根向前翻页；资金费率双边分页（HL `fundingHistory` 每页最早 500 条向前翻、OKX 最新 100 条用 `before` 向回翻），长区间不会少算累计费率。输出 JSON 契约见 `references/chart-schema.md`。

**粒度自适应**：HL 1m 历史只滚动保留最近几天（实测约 3–5 天，非固定值），5m/15m 历史完整。脚本默认按跨度自动选粒度：≤4 天 1m、≤10 天 5m、更长 15m（可用 `--interval` 覆盖）。前端实时版本同理。图标题和状态栏必须标注实际粒度；若实际数据起点晚于请求起点（脚本会打印 WARNING），必须明确告知用户，不能静默截断。

### 3. 计算口径（向用户交代清楚）

- 价差 = OKX 价(USDT) − HL 价(USDC)，按**所选粒度收盘价**对齐（短区间默认 1 分钟）；百分比价差 = 价差 / HL 收盘价 × 100。
- 时间轴用 UTC+8（用户默认中文场景）。
- HL 无成交的分钟没有 K 线，**inner join 剔除，不前向填充**；在图注里写明。
- 累计资金费率 = 区间各次结算费率简单加总（不含复利）；正 = 多头付空头，负 = 空头付多头。OKX 通常 8h 结算、HL 每小时，按各自结算时间画，不按条数对齐。
- 若用户要的是 L2 盘口级价差（bid/ask）而非 K 线收盘价，本技能不适用，改用 crypto-l2（注意 OKX 官方 L2 数据滞后 1–3 天）。

### 4. 作图（标准 schema，必须遵守）

**先读 `references/chart-schema.md`**，然后复制 `assets/echarts-app/` 为 app 骨架（Vite + echarts5），**只需改 `config.js` 里的三个合约参数**。模板为浏览器直连两所 API 的实时版，内置：时间范围按钮（24h/3d/7d/30d）+ 自定义起止、手动刷新、粒度自适应、并发分块加载、runId"最后请求生效"、导出内嵌 ECharts 与数据快照的独立 HTML（可分享，打开即用）。`npm install && npm run dev` 验证后停止服务；第 2 步的 Python 脚本用于需要 CSV、静态快照或自定义批量处理时，不是页面运行的前提。

核心要求（细则以 references 为准，模板已全部实现，优先复用不要重写）：

- 价差图**只有一条曲线**、纵轴百分比，tooltip 同时显示 % 和绝对 USD 价差。
- 资金费率图 = 单次结算柱（左轴）+ 累计阶梯虚线（右轴）。
- 三图缩放联动用手动 `datazoom` 事件 + 绝对时间窗口 dispatch，**不要用 `echarts.connect()`**。
- `vite.config.js` 需 `build.target: "esnext"`（top-level await）。

只要静态图时用 matplotlib 画同样三张子图即可，口径不变。

### 5. 交付

给出预览链接/图片，附关键数字：最新价差（% 和 USD）、区间均值与极值、两所累计资金费率及结算次数，并说明对齐分钟数与数据截止时间。
