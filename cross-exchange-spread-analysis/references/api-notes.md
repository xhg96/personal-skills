# OKX / Hyperliquid API 实测笔记

跨所价差分析涉及的公开接口、分页方式与实测限制。以下为实测行为（2026-10），可能随交易所调整，遇到空数据先按本文排查。

## OKX（www.okx.com，公开行情，CORS 允许浏览器直连）

- 合约存在性：`GET /api/v5/public/instruments?instType=SWAP&instId=<BASE>-USDT-SWAP`。
- K 线：`GET /api/v5/market/history-candles?instId=...&bar=1m&limit=100&after=<ms>`
  - **每页最多 100 根**，`after` 为毫秒游标，返回该时刻之前最新的 100 根（向回翻页）。
  - **必须带浏览器 User-Agent**，默认 `python-urllib` UA 返回 403。
  - 长区间按"100 根 × 周期"分块并发，但必须配合下面的限流 pacing；串行 7 天 1m 要 100+ 页，非常慢。
  - `bar` 支持 `1m/5m/15m/1H` 等，长历史可用。
- **限流（2026-10-24 实测踩坑）**：公开行情约 20 次 / 2 秒 / IP（≈10 req/s）。8 路并发 + 连续切换范围会触发 `HTTP 429`，导致加载失败。治理方案（已在前端模板实现）：
  - 所有 OKX 请求（含 funding）经统一 `okxSlot()` 排队，请求起点最小间隔 150ms（≈6–7 req/s），worker 降 4 路。
  - 429/5xx 用指数退避（2s 基数、×1.8、封顶 20s）+ 随机抖动，尊重 `Retry-After`，最多 6 次；网络/超时 1s 基数。fetch 必须带 20s 超时，否则单请求挂起会卡住整个加载。
  - 限流重试时在状态栏提示"触发限流，自动等待重试"，避免看似卡死。
  - 参考耗时：3 天 1m ≈ 8s，30 天 15m ≈ 16s，24h ≈ 3s。
- 指数价格：`GET /api/v5/market/index-candles?instId=<BASE>-USDT&bar=...`（永续 instId 去掉 `-SWAP` 即为指数 instId），分页参数同 K 线。**滚动保留约 1440 根/周期**（实测 1m≈24h、5m≈5 天、15m≈15 天），更早返回空；长区间只能画出近段，需提示实际覆盖起点。标记价格另有 `/api/v5/market/mark-price-candles`。
  - Hyperliquid 的 `oraclePx`/`markPx` 只有当前值（`metaAndAssetCtxs`），**无公开历史接口**，画历史 oracle 曲线不可行，用 OKX 指数价格替代。
- 资金费率：`GET /api/v5/public/funding-rate-history?instId=...&limit=100`
  - 返回**最新 100 条**，更早的用 `&before=<最早fundingTime-1>` 向回翻页；通常 8 小时一次结算。
  - 30 天约 90 条，一页够；自定义更长区间必须翻页，否则累计费率少算。

## Hyperliquid（api.hyperliquid.xyz/info，POST JSON，CORS `*`）

- 主站合约：`{"type":"meta"}`；HIP-3：`{"type":"perpDexs"}` 拿 dex 列表，再 `{"type":"meta","dex":"<dex>"}`。命中后 `coin` 必须带前缀，如 `xyz:UNITREE`。
- K 线：`{"type":"candleSnapshot","req":{"coin","interval","startTime","endTime"}}`
  - 每次最多 5000 根；按 5000 根 × 周期分块（可并发 4 路），或按最后时间戳向前翻页。
  - **1m 历史仅滚动保留最近几天（实测约 3–5 天，非官方固定值）**：2026-10-21 能取到 10-16 的 1m，2026-10-24 取 10-21 之前的 1m 已返回空。超出保留期的请求可能返回空，也可能返回与请求窗口不符的少量数据，**必须按时间戳过滤 + 检查实际覆盖**，不能静默展示。
  - `5m/15m/1h` 历史完整（实测 5m 可取 10 天前、15m/1h 可取 30 天前）。
- 资金费率：`{"type":"fundingHistory","coin","startTime","endTime"}`
  - **每次最多 500 条，且返回的是从 startTime 起最早的 500 条**（不是最新 500 条）。
  - 翻页方向：**向前**，下一页 `startTime = 本页最后一条 time + 1`；每小时一次结算，30 天 = 720 条必须翻页，否则累计费率只算到前 500 小时。
  - 无成交周期没有 K 线，对齐时 inner join、不前向填充。

## 粒度自适应策略（长区间必须降粒度）

| 请求跨度 | K 线粒度 | 原因 |
| --- | --- | --- |
| ≤ 4 天 | 1m | HL 1m 保留期内 |
| 4–10 天（如近 7 天） | 5m | HL 1m 已不可得，5m 完整 |
| > 10 天（如近 30 天） | 15m | 兼顾完整性与点数 |

- 图标题、状态栏必须标注实际粒度，不能让用户误以为 30 天还是分钟级。
- 若 1m 区间实际起点晚于请求起点，明确提示"Hyperliquid 最早可用数据为 X"。
- 资金费率与 K 线粒度无关，始终按真实结算时间拉取并翻页。

## 其他实战经验

- 浏览器直连两所 API 均可行（OKX 回显 Origin、HL 为 `*`）；fetch 要加超时（20s）+ 重试，否则单个请求挂起会卡住整个加载。
- 多图缩放联动不要依赖 `echarts.connect()`，用 datazoom 事件 + 绝对时间窗口手动同步（见 chart-schema.md）。
- 范围/刷新切换用"最后一次请求生效"令牌（runId），旧请求结果丢弃，避免慢请求覆盖新选择。
