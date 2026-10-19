#!/usr/bin/env python3
"""OKX 历史 L2 订单簿解析与时间段查询。

Python 接口:
    from l2book import snapshots, L2Book
    for ts, bids, asks in snapshots("CXMT-USDT-SWAP", start_ms, end_ms,
                                    depth=5, data_dir="./data", interval_ms=1000):
        ...

CLI:
    python3 l2book.py --inst CXMT-USDT-SWAP --start "2026-10-08 08:00" \
        --end "2026-10-08 09:00" --depth 5 --interval-ms 1000 \
        --data-dir ./data --out out.csv
    # interval_ms=0 表示逐笔输出（每次盘口变化一行）

时间参数支持 "YYYY-MM-DD HH:MM[:SS]"（UTC）或毫秒时间戳。
数据缺失时会自动调用 download.py 下载对应日期。
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import download as dl  # noqa: E402


class L2Book:
    """增量维护的 L2 订单簿（内存中为该文件深度的全量档位）。"""

    def __init__(self):
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.ts: int = 0

    def apply(self, msg: dict):
        self.ts = int(msg["ts"])
        if msg.get("action") == "snapshot":
            self.bids.clear()
            self.asks.clear()
        for side, book in (("bids", self.bids), ("asks", self.asks)):
            for lv in msg.get(side, []):
                px, qty = float(lv[0]), float(lv[1])
                if qty == 0:
                    book.pop(px, None)
                else:
                    book[px] = qty

    def top(self, n: int):
        bids = sorted(self.bids.items(), reverse=True)[:n]
        asks = sorted(self.asks.items())[:n]
        return bids, asks


def _to_ms(s) -> int:
    s = str(s).strip()
    if s.isdigit():
        return int(s)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"无法解析时间: {s!r}（支持 UTC 'YYYY-MM-DD HH:MM' 或毫秒时间戳）")


def _data_path(inst: str, day: dt.date, depth: int, data_dir: str) -> str:
    return os.path.join(data_dir, f"{inst}-L2orderbook-{depth}lv-{day.isoformat()}.data")


def _ensure_days(inst: str, start_day: dt.date, end_day: dt.date, depth: int, data_dir: str):
    for day in dl.day_range(start_day, end_day):
        if not os.path.exists(_data_path(inst, day, depth, data_dir)):
            dl.download_day(inst, day, depth, data_dir)


def iter_events(inst: str, start_ms: int, end_ms: int, file_depth: int = 400,
                data_dir: str = "./data"):
    """逐事件迭代 [start_ms, end_ms] 内每次变化后的完整盘口（file_depth 档）。
    生成 (ts_ms, bids, asks)，bids 降序、asks 升序。"""
    start_day = dt.datetime.fromtimestamp(start_ms / 1000, dt.timezone.utc).date()
    end_day = dt.datetime.fromtimestamp(end_ms / 1000, dt.timezone.utc).date()
    _ensure_days(inst, start_day, end_day, file_depth, data_dir)
    book = L2Book()
    started = False
    for day in dl.day_range(start_day, end_day):
        path = _data_path(inst, day, file_depth, data_dir)
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for line in f:
                ts = int(line[line.index('"ts":"') + 6:line.index('"', line.index('"ts":"') + 6)])
                msg = json.loads(line)
                if ts < start_ms:
                    book.apply(msg)  # 窗口前的消息仍应用，保证窗口开始时簿是完整的
                    continue
                if ts > end_ms:
                    return
                book.apply(msg)
                started = True
                bids, asks = book.top(file_depth)
                if bids and asks:
                    yield ts, bids, asks
    if not started:
        raise FileNotFoundError(f"窗口内无数据：{inst} {_data_path(inst, start_day, file_depth, data_dir)} 等")


def snapshots(inst: str, start_ms: int, end_ms: int, depth: int = 5,
              data_dir: str = "./data", interval_ms: int = 1000):
    """接口 1：获取某品种在 [start_ms, end_ms] 的订单簿序列。

    interval_ms > 0：按固定间隔重采样，每个采样点取该时刻最新盘口 top-depth；
    interval_ms = 0：逐事件输出。
    生成 (ts_ms, bids, asks)。"""
    if interval_ms <= 0:
        for ts, bids, asks in iter_events(inst, start_ms, end_ms, 400, data_dir):
            yield ts, bids[:depth], asks[:depth]
        return
    next_ts = start_ms
    last = None
    for ts, bids, asks in iter_events(inst, start_ms, end_ms, 400, data_dir):
        last = (bids, asks)
        while next_ts <= ts:
            if last and last[0] and last[1]:
                yield next_ts, last[0][:depth], last[1][:depth]
            next_ts += interval_ms
    while next_ts <= end_ms:
        if last and last[0] and last[1]:
            yield next_ts, last[0][:depth], last[1][:depth]
        next_ts += interval_ms


def main():
    p = argparse.ArgumentParser(description="查询 OKX 历史订单簿时间段数据")
    p.add_argument("--inst", required=True)
    p.add_argument("--start", required=True, help="UTC，如 '2026-10-08 08:00'")
    p.add_argument("--end", required=True)
    p.add_argument("--depth", type=int, default=5, help="输出盘口档数，默认 5")
    p.add_argument("--interval-ms", type=int, default=1000,
                   help="重采样间隔毫秒；0 = 逐笔事件")
    p.add_argument("--data-dir", default="./data")
    p.add_argument("--out", help="输出 CSV；缺省打印到 stdout")
    a = p.parse_args()
    start_ms, end_ms = _to_ms(a.start), _to_ms(a.end)

    rows = snapshots(a.inst, start_ms, end_ms, a.depth, a.data_dir, a.interval_ms)

    def emit(w):
        w.writerow(["ts_ms", "utc", "side", "level", "price", "qty"])
        for ts, bids, asks in rows:
            t = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            for i, (px, q) in enumerate(bids, 1):
                w.writerow([ts, t, "bid", i, px, q])
            for i, (px, q) in enumerate(asks, 1):
                w.writerow([ts, t, "ask", i, px, q])

    if a.out:
        with open(a.out, "w", newline="") as f:
            emit(csv.writer(f))
        print(f"已写出 {a.out}")
    else:
        emit(csv.writer(sys.stdout))


if __name__ == "__main__":
    sys.exit(main())
