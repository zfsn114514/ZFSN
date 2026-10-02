# -*- coding: utf-8 -*-
"""
构建 ZFSN 网站的「Steam 家庭共享」游戏数据。

为什么单独一个脚本、且不需要 API Key：
    Steam 的 GetOwnedGames 接口**只返回自己拥有的游戏**，
    家庭共享来的游戏不在里面 —— 所以站点的 Steam 页一直看不到它们。
    而共享游戏在本机是有痕迹的（装在了库里就有 appmanifest /
    会出现在 libraryfolders.vdf 的 apps 列表里），
    这些数据全在本地，不需要任何 Key。

数据来源（全部本地，无需联网 Key）：
    1. <Steam>/config/libraryfolders.vdf
         → 各磁盘库文件夹里**已安装**的 appid 列表
    2. steam_games.json（由 build_steam_owned.py 生成）
         → 自己拥有的 appid，用来做差集
    3. <Steam>/userdata/<accountid>/config/localconfig.vdf
         → 本机游玩时长（分钟）

名称与封面：
    走 store.steampowered.com/api/appdetails（公开接口，无需 Key），
    顺便用它返回的 type 字段过滤掉 DLC / 原声带 / demo / 工具。

⚠ 已知限制（必须让用户知道）：
    本方法只能发现**已安装**的共享游戏。家庭里其他成员库中
    但你没装过的游戏，本地没有任何记录，无法列出来。
    要拿到完整共享库，只能登录每个家庭成员的账号逐个导出。

用法：
    python build_steam_family.py

输出：
    steam_family.json（写入站点根目录）
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps"
STORE_API = "https://store.steampowered.com/api/appdetails?appids={}&l=schinese"

# SteamID64 与 accountid 的固定偏移
STEAMID64_BASE = 76561197960265728

CACHE_DIR = os.path.join(common.tools_dir(), ".cache")
CACHE_FILE = os.path.join(CACHE_DIR, "appdetails.json")


# ──────────────────────────────────────────────────────────
#  VDF 解析
# ──────────────────────────────────────────────────────────

def _match_block(text, start):
    """从 start（'{' 之后）找到配对的 '}'，返回块内容。"""
    depth = 1
    i = start
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i]
        i += 1
    return text[start:]


def parse_library_folders(vdf_text):
    """解析 libraryfolders.vdf → [(库路径, [appid,...]), ...]

    结构形如：
        "libraryfolders"
        {
            "0"
            {
                "path"  "C:\\\\Program Files (x86)\\\\Steam"
                "apps"  { "730"  "74000614728"  ... }
            }
        }
    """
    libs = []
    for m in re.finditer(r'"(\d+)"\s*\{', vdf_text):
        block = _match_block(vdf_text, m.end())
        pm = re.search(r'"path"\s*"([^"]+)"', block)
        if not pm:
            continue
        path = pm.group(1).replace("\\\\", "\\")
        apps = []
        am = re.search(r'"apps"\s*\{', block)
        if am:
            apps_block = _match_block(block, am.end())
            # 形如 "730"  "74000614728"
            apps = [int(x) for x in re.findall(r'"(\d+)"\s+"', apps_block)]
        libs.append((path, apps))
    return libs


def parse_playtimes(vdf_text):
    """解析 localconfig.vdf 的 apps 块 → {appid: 分钟}

    结构形如：
        "apps"
        {
            "440"
            {
                "Playtime"  "16"
                ...
            }
        }
    """
    out = {}
    am = re.search(r'"apps"\s*\{', vdf_text)
    if not am:
        return out
    block = _match_block(vdf_text, am.end())
    for m in re.finditer(r'"(\d{2,8})"\s*\{', block):
        sub = _match_block(block, m.end())
        pm = re.search(r'"Playtime"\s*"(\d+)"', sub)
        if pm:
            out[int(m.group(1))] = int(pm.group(1))
    return out


# ──────────────────────────────────────────────────────────
#  本地 Steam 数据定位
# ──────────────────────────────────────────────────────────

def find_steam_root(cfg):
    """定位 Steam 安装目录。"""
    candidates = []
    configured = (cfg.get("steam_local") or {}).get("steam_root")
    if configured:
        candidates.append(configured)
    candidates += [
        "C:/Program Files (x86)/Steam",
        "C:/Program Files/Steam",
        "D:/Steam",
        "D:/Program Files (x86)/Steam",
    ]
    for c in candidates:
        if c and os.path.exists(os.path.join(c, "config", "libraryfolders.vdf")):
            return c
    return None


def collect_local_appids(steam_root, cfg):
    """汇总所有库文件夹里的 appid → {appid: 库路径}"""
    rel = (cfg.get("steam_local") or {}).get("library_folders_vdf",
                                             "config/libraryfolders.vdf")
    vdf_path = os.path.join(steam_root, rel.replace("/", os.sep))
    if not os.path.exists(vdf_path):
        print("  ✗ 找不到 {}".format(vdf_path))
        return {}

    with open(vdf_path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read()

    libs = parse_library_folders(text)
    found = {}
    for path, apps in libs:
        print("  库 {}  -> {} 个 app".format(path, len(apps)))
        for a in apps:
            found.setdefault(a, path)
    return found


def collect_playtimes(steam_root, steamid):
    """读取本机游玩时长 {appid: 分钟}"""
    try:
        account_id = int(steamid) - STEAMID64_BASE
    except (TypeError, ValueError):
        return {}
    p = os.path.join(steam_root, "userdata", str(account_id),
                     "config", "localconfig.vdf")
    if not os.path.exists(p):
        print("  （未找到 localconfig.vdf，时长将显示为未知）")
        return {}
    with open(p, "r", encoding="utf-8", errors="ignore") as f:
        return parse_playtimes(f.read())


# ──────────────────────────────────────────────────────────
#  商店接口（带缓存）
# ──────────────────────────────────────────────────────────

def load_cache():
    return common.read_json(CACHE_FILE, {}) or {}


def save_cache(cache):
    os.makedirs(CACHE_DIR, exist_ok=True)
    common.write_json(CACHE_FILE, cache)


def fetch_details(appid, cache):
    """取商店信息。结果写进缓存，重复运行不再请求。"""
    key = str(appid)
    if key in cache:
        return cache[key]

    try:
        d = common.http_json(STORE_API.format(appid), retry=2, quiet=True)
    except Exception as e:
        print("      appdetails 失败: {}".format(str(e)[:60]))
        return None

    node = (d or {}).get(key) or {}
    if not node.get("success"):
        # 无数据也缓存下来，避免每次都白请求一遍
        cache[key] = {"_nodata": True}
        time.sleep(0.35)
        return cache[key]

    data = node.get("data") or {}
    info = {
        "type": data.get("type", ""),
        "name": data.get("name", ""),
        "release": ((data.get("release_date") or {}).get("date") or ""),
        "genres": [g.get("description", "") for g in (data.get("genres") or [])][:3],
        "is_free": bool(data.get("is_free")),
    }
    cache[key] = info
    time.sleep(0.35)   # 商店接口没有明确限流，但别打太快
    return info


# ──────────────────────────────────────────────────────────
#  主流程
# ──────────────────────────────────────────────────────────

def main():
    common.banner("Steam 家庭共享游戏")

    here = common.site_root()
    cfg = common.load_config()
    steam_cfg = cfg.get("steam") or {}
    local_cfg = cfg.get("steam_local") or {}
    steamid = str(steam_cfg.get("steamid") or "")

    print("站点根目录: {}".format(here))

    # ── 1. 定位 Steam ─────────────────────────────
    common.step(1, 4, "定位本机 Steam 与库文件夹")
    steam_root = find_steam_root(cfg)
    if not steam_root:
        print("  ✗ 找不到 Steam 安装目录。")
        print("    请把正确的路径填到 tools/config.json 的")
        print("    steam_local.steam_root 后重试。")
        return
    print("  Steam: {}".format(steam_root))

    local_appids = collect_local_appids(steam_root, cfg)
    print("  本机库内 app 合计: {} 个".format(len(local_appids)))

    # ── 2. 与「自己拥有」做差集 ────────────────────
    common.step(2, 4, "与自己拥有的游戏做差集")
    owned_path = os.path.join(here, "steam_games.json")
    owned = common.read_json(owned_path, {}) or {}
    owned_ids = set()
    for g in (owned.get("games") or []):
        try:
            owned_ids.add(int(g.get("appid")))
        except (TypeError, ValueError):
            pass
    print("  steam_games.json 里自己拥有: {} 款".format(len(owned_ids)))

    exclude = set(int(x) for x in (local_cfg.get("exclude_appids") or []))
    candidates = sorted(a for a in local_appids
                        if a not in owned_ids and a not in exclude)
    print("  差集（库里有、自己没拥有）: {} 个".format(len(candidates)))
    if not candidates:
        print("  没有新增内容，直接结束。")
        return

    # ── 3. 补名称 / 封面 / 类型过滤 ────────────────
    common.step(3, 4, "从 Steam 商店补全名称与封面")
    cache = load_cache()
    include_types = set(local_cfg.get("include_types") or ["game"])
    playtimes = collect_playtimes(steam_root, steamid)
    print("  本机游玩时长记录: {} 条".format(len(playtimes)))
    print()

    games, skipped = [], []
    for i, appid in enumerate(candidates, 1):
        info = fetch_details(appid, cache)
        if not info or info.get("_nodata"):
            skipped.append((appid, "商店无数据（多半是工具/已下架）"))
            print("  [{:>2}/{}] {:<9} 跳过：商店无数据".format(i, len(candidates), appid))
            continue

        gtype = info.get("type") or "?"
        if gtype not in include_types:
            skipped.append((appid, "类型 {} 非游戏".format(gtype)))
            print("  [{:>2}/{}] {:<9} 跳过：{}".format(i, len(candidates), appid, gtype))
            continue

        mins = playtimes.get(appid, 0)
        games.append({
            "appid": appid,
            "name": info.get("name") or ("App {}".format(appid)),
            "minutes": mins,
            "hours": round(mins / 60.0, 1),
            "playtime": common.hours_text(mins),
            "cover": "{}/{}/header.jpg".format(CDN, appid),
            "capsule": "{}/{}/capsule_616x353.jpg".format(CDN, appid),
            "store": "https://store.steampowered.com/app/{}/".format(appid),
            "release": info.get("release", ""),
            "genres": info.get("genres", []),
            "free": info.get("is_free", False),
            "family": True,
        })
        print("  [{:>2}/{}] {:<9} {}  ({})".format(
            i, len(candidates), appid, games[-1]["name"], gtype))

    save_cache(cache)

    if not games:
        print()
        print("  ⚠ 差集里的 app 没有一个通过游戏类型校验。")
        print("    （说明它们都是 DLC / 原声带 / 工具，不是游戏）")
        return

    # 按时长降序，未玩过的按名字排后面
    games.sort(key=lambda x: (-x["hours"], x["name"]))
    total_minutes = sum(g["minutes"] for g in games)

    # ── 4. 写盘 ───────────────────────────────────
    common.step(4, 4, "写出 steam_family.json")
    out = {
        "source": "本机 Steam 库（libraryfolders.vdf）+ 商店接口补全",
        "note": ("家庭共享游戏：只包含本机库里**已安装**的部分。"
                 "其他成员库中未安装的游戏本地无记录，无法列出。"),
        "updated": common.now_stamp(),
        "steam_root": steam_root,
        "count": len(games),
        "total_hours": round(total_minutes / 60.0, 1),
        "games": games,
        "skipped": [{"appid": a, "reason": r} for a, r in skipped],
    }
    path = common.write_json(os.path.join(here, "steam_family.json"), out)

    print("  写出 {} 款家庭共享游戏".format(len(games)))
    print("  累计 {} ".format(common.hours_text(total_minutes)))
    print("  -> {}".format(path))
    print()
    print("  时长 TOP 8：")
    for g in games[:8]:
        print("    {:>12}   {}".format(g["playtime"], g["name"]))
    if skipped:
        print()
        print("  跳过 {} 项（DLC / 工具 / 无数据），明细见 json 的 skipped 字段".format(len(skipped)))


if __name__ == "__main__":
    main()
