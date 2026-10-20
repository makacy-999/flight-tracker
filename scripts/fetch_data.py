#!/usr/bin/env python3
"""抓取 OpenSky 中国区域航班数据，保存为静态 JSON，供前端从 GitHub 仓库读取。
规避 OpenSky CORS 限制（其仅允许自身域名跨域）。
"""
import json
import urllib.request
import datetime
import os
import sys

# 中国及周边区域
BOUNDS = {"lamin": 0, "lomin": 70, "lamax": 55, "lomax": 145}
URL = ("https://opensky-network.org/api/states/all"
       "?lamin={lamin}&lomin={lomin}&lamax={lamax}&lomax={lomax}".format(**BOUNDS))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "flights.json")

def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "flight-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def main():
    try:
        data = fetch()
    except Exception as e:
        print("FETCH_FAIL:", e, file=sys.stderr)
        sys.exit(1)

    states = data.get("states") or []
    # 精简：只保留前端需要的字段，减少文件体积
    # 索引: 0icao24,1callsign,2origin,5lon,6lat,7baro_alt,9vel,10track,11vrate
    trimmed = []
    for s in states:
        trimmed.append({
            "icao24": s[0],
            "callsign": (s[1] or "").strip(),
            "country": s[2],
            "lon": s[5], "lat": s[6],
            "alt": s[7], "vel": s[9],
            "track": s[10], "vrate": s[11],
            "t": s[4]  # last contact
        })

    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "time": data.get("time"),
        "count": len(trimmed),
        "flights": trimmed,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("OK:", len(trimmed), "flights ->", os.path.relpath(OUT))

if __name__ == "__main__":
    main()