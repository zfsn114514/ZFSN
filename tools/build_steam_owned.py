# -*- coding: utf-8 -*-
"""
构建 ZFSN 网站的 Steam「自己拥有」游戏数据 —— 走官方 Web API。

⚠ 这个脚本需要 Steam API Key，而且 Key 必须有效。
   旧 Key 已失效（接口返回 Forbidden），需要重新申请：
       https://steamcommunity.com/dev/apikey
   申请后填到 tools/config.json 的 steam.api_key
   （或设置环境变量 STEAM_API_KEY）。

数据来源：
  - ISteamUser/GetPlayerSummaries          → 玩家信息（昵称、头像、注册时间）
  - IPlayerService/GetOwnedGames           → 完整游戏库 + 精确游玩时长
  - IPlayerService/GetRecentlyPlayedGames  → 最近两周游玩

封面走 store 域名的 CDN。

前置条件：
    1. tools/config.json 里填好 api_key 与 steamid
    2. Steam 个人资料的「游戏详情」必须设为「公开」，否则游戏库为空

用法：
    python build_steam_owned.py

输出：
    steam_games.json（写入站点根目录）

    ⚠ 这个文件的结构是前端约定死的：
      games[].{appid,name,minutes,hours,playtime,cover,capsule,store}
      改动字段名会让 Steam 页整页渲染失败。
"""

import os
import sys
import time
import urllib.parse
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

API = "https://api.steampowered.com"
CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps"


def api_get(path, params, key, timeout=25, retry=3):
    """调用 Steam Web API。"""
    p = dict(params)
    p["key"] = key
    p["format"] = "json"
    url = "{}/{}?{}".format(API, path, urllib.parse.urlencode(p))
    return common.http_json(url, timeout=timeout, retry=retry)


# 一旦某次调用被判为 Forbidden，就记下来。
# 因为 Steam 在连续失败后会改口返回 Unauthorized —— 同一个 Key 两种报错，
# 如果分别给不同提示，用户会被"检查是否填错"误导（其实没填错）。
_SAW_FORBIDDEN = [False]


def explain_key_error(err):
    """把接口返回的英文错误翻译成可操作的中文提示。"""
    msg = str(err)
    if "Forbidden" in msg:
        _SAW_FORBIDDEN[0] = True
    if "Forbidden" in msg or _SAW_FORBIDDEN[0]:
        return ("API Key 被拒绝（Forbidden/Unauthorized）。"
                "Key 本身格式没问题，但已被撤销或失效。\n"
                "      → 重新申请：https://steamcommunity.com/dev/apikey\n"
                "      → 然后填到 tools/config.json 的 steam.api_key\n"
                "      → 或设置环境变量 STEAM_API_KEY")
    if "Unauthorized" in msg:
        return ("API Key 无效（Unauthorized）。\n"
                "      → 检查 tools/config.json 里 api_key 是否填错")
    if "HTTP Error 403" in msg:
        return "接口返回 403，多半是 Key 权限或调用频率问题，稍后重试。"
    return "网络或接口异常：{}".format(msg[:120])


def main():
    common.banner("Steam 游戏库（自己拥有）")

    here = common.site_root()
    cfg = common.load_config()
    steam_cfg = cfg.get("steam") or {}

    api_key = (steam_cfg.get("api_key") or "").strip()
    steamid = str(steam_cfg.get("steamid") or "").strip()
    profile_url = steam_cfg.get("profile_url") or ""
    max_games = int(steam_cfg.get("max_games") or 0)
    min_playtime = int(steam_cfg.get("min_playtime") or 0)

    print("站点根目录: {}".format(here))

    if not api_key:
        print()
        print("  ✗ 没有配置 Steam API Key。")
        print("    请编辑 tools/config.json → steam.api_key")
        print("    或设置环境变量 STEAM_API_KEY")
        return
    if not steamid:
        print()
        print("  ✗ 没有配置 steamid。请编辑 tools/config.json → steam.steamid")
        return

    # ── 1. 玩家信息 ────────────────────────────────
    common.step(1, 3, "获取玩家信息")
    player = {}
    try:
        d = api_get("ISteamUser/GetPlayerSummaries/v2/", {"steamids": steamid}, api_key)
        players = (d.get("response") or {}).get("players") or []
        player = players[0] if players else {}
    except Exception as e:
        print("      失败: {}".format(explain_key_error(e)))

    if player:
        created = player.get("timecreated")
        print("      昵称: {}  注册于 {}".format(
            player.get("personaname", "?"),
            time.strftime("%Y-%m-%d", time.localtime(created)) if created else "?"))
    else:
        print("      未能取到玩家信息，继续尝试游戏库…")

    # ── 2. 完整游戏库 + 时长 ───────────────────────
    common.step(2, 3, "获取游戏库（含游玩时长）")
    games = []
    try:
        d = api_get("IPlayerService/GetOwnedGames/v1/", {
            "steamid": steamid,
            "include_appinfo": 1,
            "include_played_free_games": 1,
        }, api_key)
        resp = d.get("response") or {}
        raw = resp.get("games") or []
        print("      接口返回 {} 款游戏".format(resp.get("game_count", len(raw))))

        for g in raw:
            mins = int(g.get("playtime_forever", 0) or 0)
            if mins < min_playtime:
                continue
            appid = g.get("appid")
            games.append({
                "appid": appid,
                "name": g.get("name", ""),
                "minutes": mins,
                "hours": round(mins / 60.0, 1),
                "playtime": common.hours_text(mins),
                "recent": int(g.get("playtime_2weeks", 0) or 0),
                "cover": "{}/{}/header.jpg".format(CDN, appid),
                "capsule": "{}/{}/capsule_616x353.jpg".format(CDN, appid),
                "store": "https://store.steampowered.com/app/{}/".format(appid),
            })
    except Exception as e:
        print("      失败: {}".format(explain_key_error(e)))

    if not games:
        print()
        print("  ⚠ 没有取到任何游戏。可能原因：")
        print("     1. API Key 失效（最常见，见上面的提示）")
        print("     2. Steam 个人资料 → 隐私设置 → 「游戏详情」不是「公开」")
        print()
        print("  steam_games.json **未被改动**，站点数据保持原样。")
        return

    games.sort(key=lambda x: -x["minutes"])
    if max_games and len(games) > max_games:
        print("      展示前 {} 款（按时长排序）".format(max_games))
        games = games[:max_games]

    total_minutes = sum(g["minutes"] for g in games)
    print("      纳入展示: {} 款，累计 {}".format(len(games), common.hours_text(total_minutes)))

    # ── 3. 最近两周 ────────────────────────────────
    common.step(3, 3, "获取最近两周游玩")
    recent = []
    try:
        d = api_get("IPlayerService/GetRecentlyPlayedGames/v1/",
                    {"steamid": steamid, "count": 6}, api_key)
        for g in (d.get("response") or {}).get("games") or []:
            appid = g.get("appid")
            m2 = int(g.get("playtime_2weeks", 0) or 0)
            recent.append({
                "appid": appid,
                "name": g.get("name", ""),
                "minutes2w": m2,
                "playtime2w": common.hours_text(m2),
                "cover": "{}/{}/header.jpg".format(CDN, appid),
            })
        print("      最近两周玩过 {} 款".format(len(recent)))
    except Exception as e:
        print("      失败: {}".format(explain_key_error(e)))

    # ── 写盘 ───────────────────────────────────────
    out = {
        "source": "Steam Web API (官方)",
        "updated": common.now_stamp(),
        "steamid": steamid,
        "profile": profile_url,
        "player": {
            "name": player.get("personaname", "ZFSN"),
            "avatar": player.get("avatarfull", ""),
            "created": (time.strftime("%Y-%m-%d", time.localtime(player["timecreated"]))
                        if player.get("timecreated") else ""),
        },
        "count": len(games),
        "total_hours": round(total_minutes / 60.0, 1),
        "games": games,
        "recent": recent,
    }
    path = common.write_json(os.path.join(here, "steam_games.json"), out)

    print()
    print("写出 {} 款游戏 -> {}".format(len(games), path))
    print()
    print("时长 TOP 10：")
    for g in games[:10]:
        print("  {:>12}   {}".format(g["playtime"], g["name"]))


if __name__ == "__main__":
    main()
