#!/usr/bin/env python3
"""抓取 OpenSky 中国区域航班数据并累积历史轨迹。
- flights.json: 当前时刻快照（前端主数据）
- tracks.json: 按 callsign 累积的历史位置点（前端画轨迹线）
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
BASE = os.path.dirname(os.path.abspath(__file__))
FLIGHTS_OUT = os.path.join(BASE, "..", "data", "flights.json")
TRACKS_OUT = os.path.join(BASE, "..", "data", "tracks.json")

# 每航班最多保留的历史点数（15分钟×64=16小时，足画轨迹）
MAX_POINTS = 64
# 当前点与旧点的最短时间差（分钟），避免重复
MIN_INTERVAL_MIN = 2

def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "flight-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def load_tracks():
    try:
        with open(TRACKS_OUT, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"tracks": {}}

def main():
    try:
        data = fetch()
    except Exception as e:
        print("FETCH_FAIL:", e, file=sys.stderr)
        sys.exit(1)

    states = data.get("states") or []
    now = datetime.datetime.now(datetime.timezone.utc)
    now_ts = int(data.get("time") or now.timestamp())

    # ---- 当前快照 ----
    trimmed = []
    for s in states:
        trimmed.append({
            "icao24": s[0],
            "callsign": (s[1] or "").strip(),
            "country": s[2],
            "lon": s[5], "lat": s[6],
            "alt": s[7], "vel": s[9],
            "track": s[10], "vrate": s[11],
            "t": s[4] or now_ts
        })
    flights = {"generated": now.isoformat(), "time": now_ts,
               "count": len(trimmed), "flights": trimmed}
    os.makedirs(os.path.dirname(FLIGHTS_OUT), exist_ok=True)
    with open(FLIGHTS_OUT, "w", encoding="utf-8") as f:
        json.dump(flights, f, ensure_ascii=False)

    # ---- 累积轨迹 ----
    tracks_data = load_tracks()
    tracks = tracks_data.get("tracks", {})
    # 清理超过保存时间(8小时)未更新的航班
    cutoff = now_ts - 8 * 3600
    for cs in list(tracks.keys()):
        pts = tracks[cs]
        if pts and pts[-1]["t"] < cutoff:
            del tracks[cs]

    for fl in trimmed:
        cs = fl["callsign"]
        if not cs:
            continue
        pts = tracks.get(cs, [])
        # 若同callsign有新点且时间差足够，才追加
        if pts and (fl["t"] - pts[-1]["t"]) < MIN_INTERVAL_MIN * 60:
            continue
        pts.append({
            "lat": fl["lat"], "lon": fl["lon"],
            "alt": fl["alt"], "vel": fl["vel"],
            "track": fl["track"], "t": fl["t"]
        })
        # 只保留最近 MAX_POINTS 点
        if len(pts) > MAX_POINTS:
            pts = pts[-MAX_POINTS:]
        tracks[cs] = pts

    out = {"generated": now.isoformat(), "count": len(tracks), "tracks": tracks}
    with open(TRACKS_OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print("OK: %d flights, %d tracks -> %s" % (len(trimmed), len(tracks), os.path.relpath(TRACKS_OUT)))

if __name__ == "__main__":
    main()