#!/usr/bin/env python3
"""下载 OKX 历史 L2 订单簿数据（官方 CDN，按 UTC 日切片）。

用法:
    python3 download.py --inst CXMT-USDT-SWAP --start 2026-10-08 --end 2026-10-10 \
        --depth 400 --data-dir ./data

幂等：目标文件已存在且非空则跳过。下载后自动解压出 .data 文件并删除 tar.gz。
"""
import argparse
import datetime as dt
import os
import sys
import tarfile
import urllib.request

CDN = "https://static.okx.com/cdn/okx/match/orderbook/pro/L2/{depth}lv/daily/{yyyymmdd}/{inst}-L2orderbook-{depth}lv-{date}.tar.gz"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


def day_range(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def download_day(inst: str, day: dt.date, depth: int, data_dir: str) -> str | None:
    """下载并解压一天的数据，返回 .data 文件路径；不存在/失败返回 None。"""
    date = day.isoformat()
    out = os.path.join(data_dir, f"{inst}-L2orderbook-{depth}lv-{date}.data")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f"[skip] {out} 已存在")
        return out
    url = CDN.format(depth=depth, yyyymmdd=day.strftime("%Y%m%d"), inst=inst, date=date)
    tmp = out + ".tar.gz"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    except urllib.error.HTTPError as e:
        print(f"[miss] {date} {inst} depth={depth}: HTTP {e.code}（数据未发布或不存在）")
        return None
    except Exception as e:
        print(f"[fail] {date} {inst}: {e}")
        return None
    os.makedirs(data_dir, exist_ok=True)
    with tarfile.open(tmp, "r:gz") as tf:
        member = next(m for m in tf.getmembers() if m.name.endswith(".data"))
        with tf.extractfile(member) as src, open(out, "wb") as dst:
            while chunk := src.read(1 << 20):
                dst.write(chunk)
    os.remove(tmp)
    print(f"[ ok ] {date} {inst} -> {out} ({os.path.getsize(out)/1e6:.1f} MB)")
    return out


def main():
    p = argparse.ArgumentParser(description="下载 OKX 历史 L2 订单簿")
    p.add_argument("--inst", required=True, help="合约代码，如 CXMT-USDT-SWAP")
    p.add_argument("--start", required=True, help="开始日期 YYYY-MM-DD（UTC）")
    p.add_argument("--end", help="结束日期 YYYY-MM-DD（UTC），默认同 start")
    p.add_argument("--depth", type=int, default=400, help="盘口深度档位，默认 400")
    p.add_argument("--data-dir", default="./data", help="数据存放目录")
    a = p.parse_args()
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end) if a.end else start
    os.makedirs(a.data_dir, exist_ok=True)
    ok = 0
    for day in day_range(start, end):
        if download_day(a.inst, day, a.depth, a.data_dir):
            ok += 1
    print(f"完成：{ok}/{(end-start).days+1} 天可用")


if __name__ == "__main__":
    sys.exit(main())
