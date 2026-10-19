# OKX 历史 L2 订单簿数据参考

## 下载地址规则

OKX 官网（okx.com/historical-data → 订单表）的下载按钮实际调用内部接口
`POST /priapi/v5/broker/public/trade-data/download-link`，返回真实文件地址。
文件托管在 CDN，路径规律（2026-10 验证）：

```
https://static.okx.com/cdn/okx/match/orderbook/pro/L2/{depth}lv/daily/{YYYYMMDD}/{instId}-L2orderbook-{depth}lv-{YYYY-MM-DD}.tar.gz
```

- `{instId}`：如 `CXMT-USDT-SWAP`、`BTC-USDT-SWAP`
- `{depth}`：页面可选深度档位（默认 400；其他档位未逐一验证，404 即该档位/日期不存在）
- 按 **UTC 日**切片；发布滞后约 1–3 天，当天数据没有
- 数据起点：2023 年 3 月起（官网说明）

## 文件内容

tar.gz 内含一个 `{instId}-L2orderbook-{depth}lv-{date}.data`，JSON Lines，每行一条：

```json
{"instId":"CXMT-USDT-SWAP","action":"snapshot","ts":"1791417600006",
 "asks":[["8.264","29","2"],...],"bids":[["8.26","100","1"],...],"checksum":...}
```

- `action`: `snapshot`（全量）或 `update`（增量，只含变动档位）
- `ts`：毫秒时间戳字符串（UTC）
- 档位数组：`[价格, 数量, 订单数, 废弃字段]`；update 中数量为 `"0"` 表示删除该档
- 每天通常以一个 snapshot 开头，之后全是 update

## 重建规则

1. 遇到 snapshot：清空簿，整体替换
2. 遇到 update：逐档应用；数量 0 → 删除，否则覆盖该价位数量
3. bids 降序、asks 升序，第 0 档即 bid1/ask1

## 注意

- 时间为 UTC；与本地时间转换由调用方负责
- `books5` 等旧格式（static.okx.com/cdn/okx/traderecords/...）已 404，勿用
- 永续 instId 以 `-SWAP` 结尾；现货为 `BASE-QUOTE`；交割合约带交割日期
