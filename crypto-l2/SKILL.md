---
name: crypto-l2
description: 加密货币交易所历史 L2 订单簿数据的下载、解析与查询工具集。当需要获取/回放历史盘口（order book）、计算历史 bid/ask 价差、重建某时刻订单簿时使用。目前支持 OKX（okx/ 子目录），后续可扩展 Binance、Hyperliquid 等其他交易所子目录。
---

# crypto-l2

按交易所组织的历史 L2 订单簿数据 pipeline。每个交易所一个子目录，内部包含下载脚本与解析/查询接口。

## 结构

- `okx/` — OKX 历史订单簿（官方 CDN 日度 tar.gz，L2，含 snapshot + update 逐笔记录）
  - `download.py` — 按品种/日期/深度下载原始数据
  - `l2book.py` — 解析数据、重建订单簿，按时间段输出盘口序列（CLI + Python 接口）
  - `reference.md` — 数据格式、URL 规则、注意事项

## 典型用法

```bash
# 1. 下载数据（幂等，已存在则跳过）
python3 okx/download.py --inst CXMT-USDT-SWAP --start 2026-10-08 --end 2026-10-08 --depth 400 --data-dir ./data

# 2. 查询某时间段盘口（重采样为固定间隔的 top-N 快照）
python3 okx/l2book.py --inst CXMT-USDT-SWAP --start "2026-10-08 08:00" --end "2026-10-08 09:00" \
    --depth 5 --interval-ms 1000 --data-dir ./data --out out.csv
```

Python 接口见 `okx/l2book.py` 的 `snapshots()` / `L2Book`。

## 注意

- OKX 数据按 **UTC 日** 切片，发布时间滞后约 1–3 天，当天数据不可用。
- 所有时间参数默认按 UTC 解释。
