# -*- coding: utf-8 -*-
"""
build_steam_family.py —— Steam 家庭共享游戏
================================================
产出：站点根目录的 steam_family.json

为什么要单独一个脚本：
    Steam 的 GetOwnedGames 只返回**自己拥有**的游戏，家庭共享来的一律不返回
    （不报错、不提示，就是没有）。所以共享库必须另想办法。

数据从哪来（三条来源，各管一段）：

    ① 家庭成员名单 —— 本机 <Steam>/userdata/<自己accountid>/config/localconfig.vdf
       的 FamilyGroup 块，里面有 groupid 和全部成员的 accountid。
       ★ 不能靠 loginusers.vdf 猜：「本机登录过的账号」跟「家庭成员」完全是两回事。
         实测本机 6 个登录账号里只有 1 个在家庭组内，其余各自属于别的家庭组。

    ② 各成员的游戏库 —— GetOwnedGames（需要 API Key）
       逐个成员查一遍取并集，再减去自己拥有的 = 家庭共享游戏。
       ⚠ 需要每位成员的「游戏详情」隐私设为公开，否则返回空对象。

    ③ 中文名 / 类型过滤 —— 商店 appdetails（免 Key，带永久缓存）
       GetOwnedGames 只给英文名，中文名得靠商店接口；
       同时用它返回的 type 过滤掉 DLC / 原声带 / Demo / 工具。

游玩时长说明：
    时长读本机 localconfig.vdf 的 Playtime —— 那是**自己在这些游戏上的时长**。
    不会去显示别的家庭成员的时长（那是别人的隐私，也容易让人误解）。

前置：tools/config.json 里的 steam.api_key 必须有效。
"""

import json
import os
import sys
import time

import common

TOTAL = 4

STORE_API = "https://store.steampowered.com/api/appdetails?appids={}&l=schinese"

# 商店接口确认"没有这条"（工具 / 已下架）—— 可以永久缓存
_NODATA = {"_nodata": True}
# 请求本身失败（网络/风控）—— 不写缓存，下次重试
_FAIL = object()


def cache_path():
    return os.path.join(common.tools_dir(), ".cache", "appdetails.json")


def load_cache():
    return common.read_json(cache_path(), {}) or {}


def save_cache(cache):
    d = os.path.dirname(cache_path())
    if not os.path.isdir(d):
        os.makedirs(d)
    common.write_json(cache_path(), cache)


def store_details(appid, cache, delay):
    """查商店 appdetails，带永久缓存。

    返回 dict（有数据）/ _NODATA（确认没有）/ _FAIL（请求失败，别缓存）
    """
    k = str(appid)
    if k in cache:
        return cache[k]

    try:
        d = common.http_json(STORE_API.format(appid), timeout=15, retry=2, quiet=True)
        info = (d or {}).get(k) or {}
        if info.get("success") and info.get("data"):
            data = info["data"]
            rec = {
                "name": data.get("name") or "",
                "type": data.get("type") or "",
                "release": (data.get("release_date") or {}).get("date") or "",
                "genres": [g.get("description") for g in (data.get("genres") or [])][:3],
                "free": bool(data.get("is_free")),
            }
        else:
            rec = _NODATA
    except Exception:
        return _FAIL          # 不写缓存，下次重试

    cache[k] = rec
    time.sleep(delay)
    return rec


def fetch_owned(steamid, key, quiet=True):
    """查某个 SteamID64 的完整游戏库。返回 ({appid: {name, minutes}}, game_count)。

    ⚠ 返回空 dict 有两种可能：隐私没公开，或者真的没有游戏。
      调用方要能区分（所以一并把 game_count 带回来）。
    """
    q = ("IPlayerService/GetOwnedGames/v1/?key={}&steamid={}"
         "&include_appinfo=1&include_played_free_games=1&format=json"
         .format(key, steamid))
    d = common.steam_api_json(q, timeout=30, retry=2, quiet=quiet)
    resp = (d or {}).get("response") or {}
    games = resp.get("games") or []
    out = {}
    for g in games:
        out[int(g["appid"])] = {
            "name": g.get("name") or "",
            "minutes": int(g.get("playtime_forever") or 0),
        }
    return out, resp.get("game_count")


def main():
    cfg = common.load_config()
    common.banner("Steam 家庭共享游戏")

    steam = cfg.get("steam") or {}
    fam_cfg = cfg.get("steam_family") or {}
    key = (steam.get("api_key") or "").strip()
    my_steamid = (steam.get("steamid") or "").strip()

    if not key or not my_steamid:
        print("  ✗ 缺少 steam.api_key 或 steam.steamid")
        print("    请先填 tools/config.json（Key 申请：https://steamcommunity.com/dev/apikey）")
        return 1

    site = common.site_root()
    out_path = os.path.join(site, "steam_family.json")

    # 自己拥有的 appid —— 从 steam_games.json 读，保证和站点上那份完全一致
    owned_doc = common.read_json(os.path.join(site, "steam_games.json"), {}) or {}
    mine = {int(g["appid"]) for g in (owned_doc.get("games") or []) if g.get("appid")}
    if not mine:
        print("  ✗ steam_games.json 里没有游戏数据")
        print("    请先跑 build_steam_owned.py（家庭共享要减去自己拥有的，否则会重复）")
        return 1

    # ── [1/4] 本机家庭组 ──────────────────────────────────
    common.step(1, TOTAL, "读取本机家庭组信息")

    root = common.find_steam_root(cfg)
    if not root:
        print("  ✗ 找不到 Steam 安装目录")
        print("    请在 tools/config.json 的 steam_local.steam_root 里指定")
        return 1
    print("  Steam 目录: {}".format(root))

    my_account = common.steam_account_id(my_steamid)
    group = common.read_family_group(root, my_account)
    if not group:
        print("  ✗ 本机 localconfig.vdf 里没有 FamilyGroup 块")
        print("    说明该账号不在 Steam 家庭组里，或 Steam 客户端没登录过。")
        print("    steam_family.json **未被改动**。")
        return 1

    members = group["members"]
    print("  家庭组: {} （groupid {}）".format(group["name"] or "?", group["groupid"]))
    print("  成员数: {} 人".format(len(members)))

    # 允许只同步部分成员（config.steam_family.include_members）
    only = [int(x) for x in (fam_cfg.get("include_members") or [])]
    if only:
        members = [m for m in members if m in only]
        print("  （配置限定只同步 {} 人）".format(len(members)))

    targets = [m for m in members if not (fam_cfg.get("skip_self", True) and m == my_account)]
    if not targets:
        print("  ✗ 没有需要查询的成员（只剩自己）")
        return 1

    login = common.read_login_users(root)   # 仅用于显示；成员归属以 FamilyGroup 为准
    for m in targets:
        sid = common.STEAMID64_BASE + m
        tag = login.get(sid, "")
        print("    - {}{}".format(sid, "  (" + tag + ")" if tag else ""))

    # ── [2/4] 逐个成员查游戏库 ────────────────────────────
    common.step(2, TOTAL, "查询各成员的完整游戏库（GetOwnedGames）")

    base = common.steam_api_base(quiet=False)
    if base.startswith("http://"):
        print("  ⚠ 走的是明文 HTTP（443 被网络拦截）。api_key 会经过链路，")
        print("    本机/家庭网络下没问题，别在公共网络里跑。")

    libs = {}
    blank = []
    for m in targets:
        sid = common.STEAMID64_BASE + m
        try:
            games, count = fetch_owned(sid, key)
        except Exception as e:
            msg = str(e)
            if "Forbidden" in msg or "Unauthorized" in msg:
                print("  ✗ API Key 被拒绝（{}）".format(msg[:40]))
                print("    → 重新申请：https://steamcommunity.com/dev/apikey")
                print("    steam_family.json **未被改动**，站点数据保持原样。")
                return 1
            print("  ! {} 查询失败: {}".format(sid, msg[:70]))
            continue

        libs[m] = games
        if not games:
            blank.append(sid)
            print("  ! {} 返回空（count={}）—— 该成员「游戏详情」可能不是公开"
                  .format(sid, count))
        else:
            print("  ✓ {} → {} 款".format(sid, len(games)))
        time.sleep(0.6)

    if not libs:
        print("  ✗ 一个成员的库都没拿到，steam_family.json **未被改动**。")
        return 1

    # ── 并集 − 自己拥有 ───────────────────────────────────
    union = {}
    for games in libs.values():
        for appid, info in games.items():
            rec = union.get(appid)
            if rec is None:
                union[appid] = {"name": info["name"], "owners": 1}
            else:
                rec["owners"] += 1

    shared = {a: v for a, v in union.items() if a not in mine}
    print()
    print("  成员并集    : {} 款".format(len(union)))
    print("  减去自己拥有: {} 款".format(len(mine)))
    print("  家庭共享    : {} 款".format(len(shared)))

    # ── [3/4] 补中文名 / 过滤类型 ─────────────────────────
    common.step(3, TOTAL, "补全游戏信息（中文名 / 封面 / 类型过滤）")

    cache = load_cache()
    installed = common.read_installed_apps(root)
    playtimes = common.read_playtimes(root, my_account)
    print("  本机已安装 {} 款 · 时长记录 {} 条 · 商店缓存 {} 条"
          .format(len(installed), len(playtimes), len(cache)))

    exclude = {int(x) for x in (cfg.get("steam_local") or {}).get("exclude_appids") or []}
    want_types = set((cfg.get("steam_local") or {}).get("include_types") or ["game"])
    verify = fam_cfg.get("verify_with_store", True)
    delay = float(fam_cfg.get("delay", 0.35))

    todo = [a for a in sorted(shared) if a not in exclude and str(a) not in cache]
    # 实测商店接口约 2s/个（比想象中慢），所以估算要按 delay + 1.9 算
    per_item = delay + 1.9
    if verify and todo:
        print("  需要新查商店的条目: {} 个（每个约 {:.1f}s，预计 {:.0f} 分钟）"
              .format(len(todo), per_item, len(todo) * per_item / 60.0))
        print("  结果会永久缓存，下次运行就很快。")
        print("  （每 25 条落一次盘，中途 Ctrl-C 也不会全丢）")

    games_out = []
    skipped = []
    failed = []          # 记下 appid，方便用户知道该重试哪几条
    # 上一次报进度时还剩多少条没查 —— 用来抑制重复输出。
    # （落盘点固定每 25 条一次，但那 25 条可能全是已缓存的，
    #   此时剩余量没变，再打一行"已查 0/12"纯属噪音）
    last_left = [len(todo)]
    for i, appid in enumerate(sorted(shared)):
        if appid in exclude:
            skipped.append({"appid": appid, "reason": "在 exclude_appids 里"})
            continue

        rec = store_details(appid, cache, delay) if verify else _NODATA
        if rec is _FAIL:
            failed.append(appid)
            rec = _NODATA      # 本次按"没有商店数据"处理；缓存里没写，下次会重试
        elif todo and (i + 1) % 25 == 0:
            save_cache(cache)  # 分批落盘，中途 Ctrl-C 也不至于全丢
            left = len([x for x in todo if str(x) not in cache])
            if left != last_left[0]:        # 只在真的有新进展时才报
                last_left[0] = left
                print("      已查 {}/{}，剩余约 {:.0f} 分钟…"
                      .format(len(todo) - left, len(todo), left * per_item / 60.0))

        name = shared[appid]["name"]
        store = {}
        if rec is _NODATA:
            # 商店查不到：多半是工具/已下架
            if verify:
                skipped.append({"appid": appid, "reason": "商店无数据（多半是工具/已下架）"})
                continue
        else:
            store = rec
            if store.get("type") and store["type"] not in want_types:
                skipped.append({"appid": appid, "reason": "类型 {} 非游戏".format(store["type"])})
                continue
            name = store.get("name") or name

        mins = int(playtimes.get(appid, 0))
        games_out.append({
            "appid": appid,
            "name": name,
            "minutes": mins,
            "hours": round(mins / 60.0, 1),
            "playtime": common.hours_text(mins),
            "cover": "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/header.jpg".format(appid),
            "capsule": "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/capsule_616x353.jpg".format(appid),
            "store": "https://store.steampowered.com/app/{}/".format(appid),
            "release": store.get("release", ""),
            "genres": store.get("genres", []),
            "free": store.get("free", False),
            "installed": appid in installed,
            "owner_count": shared[appid]["owners"],
            "family": True,
        })

    save_cache(cache)

    if failed:
        print("  ! {} 条商店查询失败（未缓存，下次运行会自动重试）：{}"
              .format(len(failed), ", ".join(str(a) for a in failed[:12])))

    if not games_out:
        print("  ✗ 过滤后一款游戏都不剩，steam_family.json **未被改动**。")
        return 1

    # ── [4/4] 写盘 ───────────────────────────────────────
    common.step(4, TOTAL, "写出 steam_family.json")

    games_out.sort(key=lambda g: (-g["hours"], g["name"]))
    total_hours = round(sum(g["minutes"] for g in games_out) / 60.0, 1)

    doc = {
        "source": "Steam 家庭组（本机 FamilyGroup）+ GetOwnedGames + 商店 appdetails",
        "note": ("家庭共享游戏：家庭组全部成员的游戏库取并集，再减去自己拥有的。"
                 "时长为**自己在这些游戏上的**游玩时长（来自本机 localconfig.vdf）。"
                 "前端会把这份数据合并进 Steam 游戏总列表。"),
        "family_group": {
            "groupid": group["groupid"],
            "name": group["name"],
            "members": len(members),
            "queried": len(libs),
            "private": blank,
        },
        "updated": common.now_stamp(),
        "steam_root": root,
        "count": len(games_out),
        "total_hours": total_hours,
        "installed_count": sum(1 for g in games_out if g["installed"]),
        "games": games_out,
        "skipped": skipped,
        # 本次没查到商店数据的 appid（多为网络抖动）。它们**没写进缓存**，
        # 所以重跑会自动重试；列在这里便于对照"是不是少了这几款"。
        "failed_store": failed,
    }
    common.write_json(out_path, doc)

    print("  写出 {} 款家庭共享游戏".format(len(games_out)))
    print("  累计 {} 小时（自己在这些游戏上的时长）".format(total_hours))
    print("  其中本机已安装 {} 款".format(doc["installed_count"]))
    print("  跳过 {} 项（DLC / 原声带 / Demo / 工具）".format(len(skipped)))
    for s in skipped[:8]:
        print("      {} → {}".format(s["appid"], s["reason"]))
    if len(skipped) > 8:
        print("      …（共 {} 项，完整列表见 json 的 skipped 字段）".format(len(skipped)))

    top = [g for g in games_out if g["hours"] > 0][:8]
    if top:
        print()
        print("  时长 TOP {}：".format(len(top)))
        for g in top:
            print("      {:>10}   {}".format(g["playtime"], g["name"]))

    print()
    print("  完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
