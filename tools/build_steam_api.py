# -*- coding: utf-8 -*-
"""
构建 ZFSN 网站的 Steam 游戏库数据 —— 使用官方 Web API 拉取真实数据。

数据来源（均需网络可达 api.steampowered.com）：
  - ISteamUser/GetPlayerSummaries  -> 玩家信息（昵称、头像、注册时间）
  - IPlayerService/GetOwnedGames   -> 完整游戏库 + 精确游玩时长
  - IPlayerService/GetRecentlyPlayedGames -> 最近两周游玩

封面图走 store 域名的 CDN（可达）。

用法：
    python build_steam.py

前置条件：
    1. 在该文件中填入 STEAM_API_KEY 与 STEAM_ID
    2. Steam 个人资料的「游戏详情」必须设为「公开」，否则游戏库为空

输出：steam_games.json（写入站点根目录，供前端直接读取）
"""
import json
import os
import time
import urllib.request
import urllib.parse
import urllib.error

# ══════════════════════════════════════════════════════════
#  配置区
# ══════════════════════════════════════════════════════════
STEAM_API_KEY = "775528DF7EAACB3861BCADBA75E5A87A"
STEAM_ID = "76561199577166952"

# 页面展示数量上限（按游玩时长降序取前 N 款；设为 0 表示全部展示）
MAX_GAMES = 0

# 少于这个时长的游戏不在「游戏库」展示（单位：分钟，设 0 表示不过滤）
MIN_PLAYTIME = 0

API = "https://api.steampowered.com"
CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")


def site_root():
    """定位站点根目录（存放 index.html 的地方）。"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(script_dir, "index.html")):
        return script_dir
    parent = os.path.dirname(script_dir)
    if os.path.exists(os.path.join(parent, "index.html")):
        return parent
    return script_dir


def api_get(path, params, timeout=25, retry=3):
    """调用 Steam Web API，返回解析后的 JSON。"""
    params = dict(params)
    params["key"] = STEAM_API_KEY
    params["format"] = "json"
    url = "{}/{}?{}".format(API, path, urllib.parse.urlencode(params))
    last = None
    for attempt in range(retry):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:
            last = e
            if attempt < retry - 1:
                wait = 3 * (attempt + 1)
                print("      请求失败({})，{}s 后重试…".format(e, wait))
                time.sleep(wait)
    raise last


def hours(mins):
    """分钟 -> 可读时长字符串"""
    if not mins:
        return "未玩过"
    if mins < 60:
        return "{} 分钟".format(mins)
    h = mins / 60.0
    if h < 100:
        return "{:.1f} 小时".format(h)
    return "{:,} 小时".format(int(round(h)))


def main():
    here = site_root()
    print("站点根目录: {}".format(here))
    print()

    # ── 1. 玩家信息 ──────────────────────────────────
    print("[1/3] 获取玩家信息…")
    try:
        d = api_get("ISteamUser/GetPlayerSummaries/v2/", {"steamids": STEAM_ID})
        players = d.get("response", {}).get("players", [])
        player = players[0] if players else {}
    except Exception as e:
        print("      失败: {}".format(e))
        player = {}

    if player:
        print("      昵称: {}  注册于 {}".format(
            player.get("personaname", "?"),
            time.strftime("%Y-%m-%d", time.localtime(player.get("timecreated", 0)))
            if player.get("timecreated") else "?"))

    # ── 2. 完整游戏库 + 时长 ─────────────────────────
    print("[2/3] 获取游戏库（含游玩时长）…")
    games = []
    try:
        d = api_get("IPlayerService/GetOwnedGames/v1/", {
            "steamid": STEAM_ID,
            "include_appinfo": 1,
            "include_played_free_games": 1,
        })
        raw = d.get("response", {}).get("games", [])
        total_count = d.get("response", {}).get("game_count", len(raw))
        print("      接口返回 {} 款游戏".format(total_count))

        for g in raw:
            mins = g.get("playtime_forever", 0)
            if mins < MIN_PLAYTIME:
                continue
            appid = g.get("appid")
            games.append({
                "appid": appid,
                "name": g.get("name", ""),
                "minutes": mins,
                "hours": round(mins / 60.0, 1),
                "playtime": hours(mins),
                "recent": g.get("playtime_2weeks", 0),
                "cover": "{}/{}/header.jpg".format(CDN, appid),
                "capsule": "{}/{}/capsule_616x353.jpg".format(CDN, appid),
                "store": "https://store.steampowered.com/app/{}/".format(appid),
            })
    except Exception as e:
        print("      失败: {}".format(e))

    if not games:
        print()
        print("  ⚠ 游戏库为空。最可能的原因：")
        print("     Steam 个人资料的「游戏详情」隐私设置为「私密」。")
        print("     请到 Steam → 个人资料 → 编辑 → 隐私设置 → 游戏详情 → 改为「公开」")

    # 按游玩时长降序
    games.sort(key=lambda x: -x["minutes"])
    if MAX_GAMES and len(games) > MAX_GAMES:
        print("      展示前 {} 款（按时长排序）".format(MAX_GAMES))
        games = games[:MAX_GAMES]

    total_minutes = sum(g["minutes"] for g in games)
    print("      纳入展示: {} 款，累计 {} ".format(len(games), hours(total_minutes)))

    # ── 3. 最近两周 ──────────────────────────────────
    print("[3/3] 获取最近游玩…")
    recent = []
    try:
        d = api_get("IPlayerService/GetRecentlyPlayedGames/v1/", {
            "steamid": STEAM_ID, "count": 6,
        })
        for g in d.get("response", {}).get("games", []):
            appid = g.get("appid")
            m2 = g.get("playtime_2weeks", 0)
            recent.append({
                "appid": appid,
                "name": g.get("name", ""),
                "minutes2w": m2,
                "playtime2w": hours(m2),
                "cover": "{}/{}/header.jpg".format(CDN, appid),
            })
        print("      最近两周玩过 {} 款".format(len(recent)))
    except Exception as e:
        print("      失败: {}".format(e))

    # ── 写盘 ────────────────────────────────────────
    out = {
        "source": "Steam Web API (官方)",
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "steamid": STEAM_ID,
        "profile": "https://steamcommunity.com/id/ZFSN114514/",
        "player": {
            "name": player.get("personaname", "ZFSN"),
            "avatar": player.get("avatarfull", ""),
            "created": time.strftime("%Y-%m-%d", time.localtime(player["timecreated"]))
                       if player.get("timecreated") else "",
        },
        "count": len(games),
        "total_hours": round(total_minutes / 60.0, 1),
        "games": games,
        "recent": recent,
    }

    path = os.path.join(here, "steam_games.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print()
    print("写出 {} 款游戏 -> {}".format(len(games), path))
    print()
    print("时长 TOP 10：")
    for g in games[:10]:
        print("  {:>12}   {}".format(g["playtime"], g["name"]))


if __name__ == "__main__":
    main()
