#!/usr/bin/env python3
"""Fetch minute candles + funding history for a cross-exchange perp pair
(OKX USDT-margined swap vs Hyperliquid USDC-margined perp, incl. HIP-3 dex
coins such as "xyz:UNITREE"), align by minute close, and emit the JSON
schema consumed by assets/echarts-app (see references/chart-schema.md).

Example:
  python3 scripts/fetch_spread_data.py \
      --okx-inst UNITREE-USDT-SWAP --hl-coin xyz:UNITREE \
      --hl-coin-extra para:UNITREE --days 5 --out spread_data.json --csv-dir .

All timestamps in the output are Unix milliseconds (UTC).
"""
import argparse, csv, json, os, time, urllib.request

MIN = 60_000
DAY = 86_400_000


def http_json(url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        # OKX returns 403 for the default python-urllib UA
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def okx_candles(inst, start, now, bar="1m", step=MIN):
    """history-candles, 100 per page, paginate backwards with `after`."""
    rows, end = [], now
    while end > start:
        d = http_json("https://www.okx.com/api/v5/market/history-candles"
                      f"?instId={inst}&bar={bar}&limit=100&after={end}")
        data = d.get("data", [])
        if not data:
            break
        # row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        rows += [(int(r[0]), float(r[1]), float(r[4])) for r in data]
        oldest = int(data[-1][0])
        if oldest >= end:
            break
        end = oldest - 1
        time.sleep(0.12)
    return sorted({r[0]: r for r in rows if r[0] >= start}.values())


def hl_candles(coin, start, now, interval="1m", step=MIN):
    """candleSnapshot, <=5000 per page, paginate forwards; periods without
    trades are simply absent (do NOT forward-fill).
    WARNING: HL 1m history only covers the last few days (rolling); requests
    older than that may return empty or out-of-window rows -> filter by ts."""
    rows = []
    t0 = start
    while start < now:
        d = http_json("https://api.hyperliquid.xyz/info",
                      {"type": "candleSnapshot",
                       "req": {"coin": coin, "interval": interval,
                               "startTime": start, "endTime": now}})
        if not d:
            break
        rows += [(k["t"], float(k["o"]), float(k["c"])) for k in d]
        nxt = d[-1]["t"] + step
        if nxt <= start:
            break
        start = nxt
        time.sleep(0.3)
    return sorted({r[0]: r for r in rows if t0 <= r[0] < now}.values())


def hl_funding(coin, start, now):
    """fundingHistory returns the EARLIEST 500 records from startTime;
    paginate FORWARD or long ranges silently lose the recent settlements."""
    rows, cursor = [], start
    while cursor < now:
        d = http_json("https://api.hyperliquid.xyz/info",
                      {"type": "fundingHistory", "coin": coin,
                       "startTime": cursor, "endTime": now})
        if not d:
            break
        rows += [[int(r["time"]), float(r["fundingRate"])] for r in d]
        nxt = int(d[-1]["time"]) + 1
        if len(d) < 500 or nxt <= cursor:
            break
        cursor = nxt
        time.sleep(0.3)
    return sorted({r[0]: r for r in rows if r[0] >= start}.values())


def okx_funding(inst, start):
    """funding-rate-history returns the latest 100; paginate backwards
    with `before` when the range has >100 settlements (>~33 days at 8h)."""
    rows, before = [], None
    while True:
        url = ("https://www.okx.com/api/v5/public/funding-rate-history"
               f"?instId={inst}&limit=100" + (f"&before={before}" if before else ""))
        data = http_json(url).get("data", [])
        if not data:
            break
        rows += [[int(r["fundingTime"]), float(r["fundingRate"])] for r in data]
        oldest = min(int(r["fundingTime"]) for r in data)
        if len(data) < 100 or oldest <= start:
            break
        before = oldest - 1
        time.sleep(0.12)
    return sorted({r[0]: r for r in rows if r[0] >= start}.values())


def align(okx_rows, hl_rows):
    """Inner join on minute timestamp; spread = OKX close - HL close."""
    hl = {r[0]: r for r in hl_rows}
    points = []
    for ts, _, c_okx in okx_rows:
        if ts in hl:
            c_hl = hl[ts][2]
            spread = c_okx - c_hl
            points.append([ts, round(c_okx, 6), round(c_hl, 6),
                           round(spread, 6), round(spread / c_hl * 100, 6)])
    mean = sum(p[3] for p in points) / len(points) if points else 0.0
    return {"points": points, "mean": round(mean, 6)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--okx-inst", required=True, help="e.g. UNITREE-USDT-SWAP")
    ap.add_argument("--hl-coin", required=True, help='primary HL coin, e.g. "xyz:UNITREE"')
    ap.add_argument("--hl-coin-extra", help="optional second HL coin for the price chart")
    ap.add_argument("--days", type=float, default=5)
    ap.add_argument("--interval", choices=["1m", "5m", "15m", "1h"], default=None,
                    help="default: auto by span (<=4d 1m, <=10d 5m, else 15m); "
                         "HL 1m history only covers the last few days")
    ap.add_argument("--out", default="spread_data.json")
    ap.add_argument("--csv-dir", help="optional directory for aligned per-period CSVs")
    args = ap.parse_args()

    now = int(time.time() * 1000)
    start = now - int(args.days * DAY)
    interval = args.interval or ("1m" if args.days <= 4 else "5m" if args.days <= 10 else "15m")
    step = {"1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": 60 * MIN}[interval]
    okx_bar = "1H" if interval == "1h" else interval

    okx = okx_candles(args.okx_inst, start, now, okx_bar, step)
    print(f"OKX {args.okx_inst}: {len(okx)} {interval} candles")

    coins = [("primary", args.hl_coin)]
    if args.hl_coin_extra:
        coins.append(("extra", args.hl_coin_extra))

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now / 1000 + 8 * 3600)) + " (UTC+8)",
        "meta": {"okx_inst": args.okx_inst, "hl_coin": args.hl_coin,
                 "hl_coin_extra": args.hl_coin_extra, "days": args.days, "interval": interval},
        "series": {}, "funding": {},
    }
    for key, coin in coins:
        hl = hl_candles(coin, start, now, interval, step)
        s = align(okx, hl)
        payload["series"][key] = s
        print(f"HL {coin}: {len(hl)} candles, aligned {len(s['points'])} periods, "
              f"mean spread {s['mean']}")
        if s["points"] and s["points"][0][0] > start + 2 * step:
            first = time.strftime("%m-%d %H:%M", time.gmtime(s["points"][0][0] / 1000 + 8 * 3600))
            print(f"WARNING: earliest aligned data {first} (UTC+8) is later than requested "
                  f"start; HL has no {interval} history before that")
        payload["funding"][key] = hl_funding(coin, start, now)
        time.sleep(0.3)
        if args.csv_dir:
            os.makedirs(args.csv_dir, exist_ok=True)
            path = os.path.join(args.csv_dir, f"spread_{key}.csv")
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["ts", "okx_close", "hl_close", "spread_abs", "spread_pct"])
                w.writerows(s["points"])
            print(f"saved {path}")

    payload["funding"]["okx"] = okx_funding(args.okx_inst, start)

    for k, v in payload["funding"].items():
        print(f"funding {k}: {len(v)} settlements, cumulative {sum(r[1] for r in v) * 100:.4f}%")

    with open(args.out, "w") as f:
        json.dump(payload, f)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
