# -*- coding: utf-8 -*-
"""
[已废弃 / 备用] 构建 Steam 游戏数据 —— 不依赖 API Key 的降级方案。

⚠ 正常情况下请使用 build_steam_api.py（走官方 API，能拿到真实游玩时长）。
   本脚本仅在「没有 API Key」或「api.steampowered.com 不可达」时作为备用。

原理：因 api.steampowered.com / steamcommunity.com 在国内网络不稳定，
无法读取个人游戏库与游玩时长，故：
  - 通过可达的 store.steampowered.com/api/appdetails 拉取游戏真实中文名
  - 通过可达的 cdn.cloudflare.steamstatic.com 获取官方封面图
缺点：游戏列表需要在下方 APPIDS 手动维护，且没有游玩时长。
"""
import json
import urllib.request
import urllib.parse
import time
import os

# 精选游戏（appid 列表）。可按需增删，重新运行本脚本即可刷新。
APPIDS = [
    1245620,   # 艾尔登法环
    271590,    # 侠盗猎车手 V
    1091500,   # 赛博朋克 2077
    292030,    # 巫师3：狂猎
    730,       # 反恐精英2
    570,       # Dota 2
    1174180,   # 荒野大镖客2
    1086940,   # 博德之门3
    1237970,   # 泰坦陨落2
    359550,    # 彩虹六号：围攻
    236390,    # 战争雷霆
    252490,    # Rust
]


def site_root():
    """定位站点根目录（存放 index.html 的地方）。

    脚本可能被放在站点根目录，也可能放在 tools/ 子目录，两种都要能工作。
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(script_dir, "index.html")):
        return script_dir
    parent = os.path.dirname(script_dir)
    if os.path.exists(os.path.join(parent, "index.html")):
        return parent
    return script_dir   # 兜底


API = "https://store.steampowered.com/api/appdetails?appids={}&l=schinese"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def fetch(appid):
    url = API.format(appid)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read().decode("utf-8", "ignore")
    data = json.loads(raw)
    node = data.get(str(appid)) or {}
    if not node.get("success"):
        return None
    d = node["data"]
    return {
        "appid": appid,
        "name": d.get("name", ""),
        "header": "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/header.jpg".format(appid),
        "capsule": "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/capsule_616x353.jpg".format(appid),
        "store": "https://store.steampowered.com/app/{}/".format(appid),
        "genres": [g.get("description", "") for g in (d.get("genres") or [])][:3],
        "release": (d.get("release_date") or {}).get("date", ""),
        "free": bool(d.get("is_free")),
        "desc": (d.get("short_description") or "")[:110],
    }


def main():
    out = []
    for i, aid in enumerate(APPIDS):
        try:
            info = fetch(aid)
            if info:
                out.append(info)
                print("[OK ] {} {}  {}".format(aid, info["name"], "|".join(info["genres"])))
            else:
                print("[SKIP] {} 无数据".format(aid))
        except Exception as e:
            print("[FAIL] {} {}".format(aid, e))
        time.sleep(0.8)  # 避免触发限流

    here = site_root()
    path = os.path.join(here, "steam_games.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({
            "profile": "https://steamcommunity.com/id/ZFSN114514/",
            "note": "游戏名与封面取自 Steam 官方商店接口；因网络限制未包含个人游玩时长。",
            "count": len(out),
            "games": out,
        }, f, ensure_ascii=False, indent=2)
    print("\n写出 {} 条 -> {}".format(len(out), path))


if __name__ == "__main__":
    main()
