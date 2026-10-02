# -*- coding: utf-8 -*-
"""
⚠ 已被 tools/build_bili_full.py 取代，日常不用跑本脚本。

    新流程：
        node tools/fetch_bili_list_cdp.js   抓全量投稿列表（真实 Chrome）
        python tools/build_bili_full.py     补详情 + 封面 + 账号信息

    build_bili_full.py 已经包含了本脚本的全部职责（账号信息 + 逐条详情），
    而且账号信息改走 m.bilibili.com 的 SSR 数据（acc/info 常年被 -352 风控）。

    本脚本保留作为**应急兜底**：当缓存列表丢失、只想给现有
    bili_videos.json 补互动数据时，它仍然可用。


────────────── 以下为原始说明 ──────────────

给现有的 bili_videos.json 补上账号总览（profile）与视频详情字段。

用途：当 build_bili.py 因为 B站 风控（412 / -352）拿不到 space 列表时，
      视频列表可以沿用旧数据，但账号信息和互动数据仍可单独补齐 ——
      因为 /x/relation/stat 与 /x/web-interface/view 走的是不同的限流策略，
      往往在 space 列表被限流时仍然可用。

用法：
    python build_bili_profile.py          # 补齐账号信息 + 所有视频详情
    python build_bili_profile.py --profile-only   # 只补账号信息，不碰视频
"""
import json
import time
import sys
import urllib.request
import urllib.error
import http.cookiejar
import os

MID = 1220210222
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

PROFILE_ONLY = "--profile-only" in sys.argv


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def site_root():
    """定位站点根目录。实现已统一到 common.site_root()，这里只做转发。"""
    return common.site_root()


cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def get(url, timeout=15, retry=3):
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://space.bilibili.com/{}/".format(MID),
    }
    last = None
    for attempt in range(retry):
        try:
            req = urllib.request.Request(url, headers=h)
            with opener.open(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (412, 429, 503):
                wait = 8 * (attempt + 1)
                print("      [{}] 限流，等待 {}s…".format(e.code, wait))
                time.sleep(wait)
                continue
            raise
    raise last


def num(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


def fmt_count(n):
    n = num(n)
    if n >= 100000000:
        return "{:.2f}亿".format(n / 100000000).rstrip("0").rstrip(".")
    if n >= 10000:
        return "{:.1f}万".format(n / 10000).rstrip("0").rstrip(".")
    return str(n)


def sec_to_hms(sec):
    sec = num(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "{}:{:02d}:{:02d}".format(h, m, s)
    return "{:02d}:{:02d}".format(m, s)


def main():
    here = site_root()
    path = os.path.join(here, "bili_videos.json")
    if not os.path.exists(path):
        print("[错误] 找不到 {}".format(path))
        return

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    videos = data.get("videos") or []
    print("读入 {} 条投稿".format(len(videos)))

    # 预热 cookie
    try:
        get("https://www.bilibili.com/")
        d = json.loads(get("https://api.bilibili.com/x/frontend/finger/spi"))
        if d.get("code") == 0 and d.get("data"):
            for name, val in (("buvid3", d["data"].get("b_3")), ("buvid4", d["data"].get("b_4"))):
                if val:
                    cj.set_cookie(http.cookiejar.Cookie(
                        0, name, val, None, False, ".bilibili.com", True, True,
                        "/", True, True, None, False, None, None, {}, False))
        print("[0] cookie 就绪")
    except Exception as e:
        print("[0] 预热失败: {}".format(e))

    profile = data.get("profile") or {"mid": MID}

    # ── 1. 账号信息 ──
    print("\n[1] 获取账号信息…")

    # acc/info（有时 -799 限流，多次尝试）
    for attempt in range(3):
        try:
            d = json.loads(get("https://api.bilibili.com/x/space/acc/info?mid={}".format(MID)))
            if d.get("code") == 0 and d.get("data"):
                dd = d["data"]
                profile["name"] = dd.get("name", profile.get("name", ""))
                profile["face"] = (dd.get("face") or "").replace("http://", "https://")
                profile["sign"] = dd.get("sign", profile.get("sign", ""))
                profile["level"] = num((dd.get("level_info") or {}).get(
                    "current_level", dd.get("level", 0)))
                jt = num(dd.get("jointime"))
                if jt:
                    profile["jointime"] = time.strftime("%Y-%m-%d", time.localtime(jt))
                profile["birthday"] = dd.get("birthday", "")
                print("      昵称={} 等级=Lv{}".format(profile["name"], profile["level"]))
                break
            else:
                print("      acc/info code={}（可能限流，稍后重试）".format(d.get("code")))
                time.sleep(6)
        except Exception as e:
            print("      acc/info 失败: {}".format(e))
            time.sleep(6)

    time.sleep(2)

    # relation/stat —— 实测最稳定
    try:
        d = json.loads(get("https://api.bilibili.com/x/relation/stat?vmid={}".format(MID)))
        if d.get("code") == 0 and d.get("data"):
            profile["followers"] = num(d["data"].get("follower"))
            profile["following"] = num(d["data"].get("following"))
            print("      粉丝={} 关注={}".format(profile["followers"], profile["following"]))
    except Exception as e:
        print("      relation/stat 失败: {}".format(e))

    time.sleep(2)

    # upstat（累计获赞）—— 该账号可能返回空对象，属正常
    try:
        d = json.loads(get("https://api.bilibili.com/x/space/upstat?mid={}".format(MID)))
        if d.get("code") == 0 and d.get("data"):
            profile["likes"] = num((d["data"].get("likes") or {}).get("total"))
            if profile["likes"]:
                print("      累计获赞={}".format(profile["likes"]))
    except Exception as e:
        print("      upstat 失败: {}".format(e))

    # ── 2. 视频详情 ──
    if not PROFILE_ONLY:
        print("\n[2] 补齐视频详情（互动数据）…")
        changed = 0
        for i, v in enumerate(videos, 1):
            bvid = v.get("bvid")
            if not bvid:
                continue
            # 已经有完整数据的就跳过。
            # ⚠ 不要用 tname 做判断：快手搬运的老视频在 B站 上**本来就没有分区**，
            #   tname 会一直是空串，导致"永远需要重抓"，白白烧掉风控额度。
            #   真正代表"已经抓过详情"的是 like/coin 这类 stat 字段。
            if v.get("like") is not None and v.get("coin") is not None and v.get("duration"):
                print("    [{}/{}] 已有数据，跳过".format(i, len(videos)))
                continue
            print("    [{}/{}] {}".format(i, len(videos), (v.get("title") or "")[:34]))
            try:
                d = json.loads(get(
                    "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid,
                    retry=3))
                if d.get("code") == 0 and d.get("data"):
                    dd = d["data"]
                    st = dd.get("stat") or {}
                    v["views"] = num(st.get("view", v.get("views", 0)))
                    v["danmaku"] = num(st.get("danmaku"))
                    v["reply"] = num(st.get("reply"))
                    v["like"] = num(st.get("like"))
                    v["coin"] = num(st.get("coin"))
                    v["favorite"] = num(st.get("favorite"))
                    v["share"] = num(st.get("share"))
                    v["tname"] = (dd.get("tname") or "").strip()
                    v["duration"] = num(dd.get("duration"))
                    v["length"] = sec_to_hms(v["duration"])
                    v["pages"] = num(dd.get("videos", 1))
                    if dd.get("desc"):
                        v["desc"] = dd["desc"][:200]
                    changed += 1
                    print("        播放 {} | 赞 {} | 币 {} | 藏 {}".format(
                        fmt_count(v["views"]), fmt_count(v["like"]),
                        fmt_count(v["coin"]), fmt_count(v["favorite"])))
                else:
                    print("        code={}（限流，跳过）".format(d.get("code")))
            except Exception as e:
                print("        失败: {}".format(e))
            time.sleep(2.5)
        print("\n    共更新 {} 条".format(changed))

    # ── 3. 汇总统计 ──
    total_views = sum(num(v.get("views")) for v in videos)
    total_likes = sum(num(v.get("like")) for v in videos)
    profile["total_views"] = total_views
    profile["total_likes"] = total_likes
    profile["total_coins"] = sum(num(v.get("coin")) for v in videos)
    profile["total_favorites"] = sum(num(v.get("favorite")) for v in videos)
    profile["total_danmaku"] = sum(num(v.get("danmaku")) for v in videos)
    profile["total_replies"] = sum(num(v.get("reply")) for v in videos)
    profile["total_duration"] = sum(num(v.get("duration")) for v in videos)
    if not profile.get("likes"):
        profile["likes"] = total_likes
    profile["followers_text"] = fmt_count(profile.get("followers"))
    profile["likes_text"] = fmt_count(profile.get("likes"))
    profile["total_views_text"] = fmt_count(total_views)

    # 头像本地化
    if profile.get("face"):
        try:
            req = urllib.request.Request(profile["face"], headers={
                "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
            with urllib.request.urlopen(req, timeout=20) as r:
                blob = r.read()
            if len(blob) > 800:
                with open(os.path.join(here, "assets", "bili_avatar.jpg"), "wb") as f:
                    f.write(blob)
                profile["face_local"] = "assets/bili_avatar.jpg"
                print("\n[3] 头像已保存")
        except Exception as e:
            print("\n[3] 头像下载失败: {}".format(e))

    data["profile"] = profile
    data["count"] = len(videos)
    data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

    print("\n[4] 已写回 {}".format(path))
    print("    粉丝 {} | 总播放 {} | 总点赞 {}".format(
        fmt_count(profile.get("followers")),
        fmt_count(total_views), fmt_count(total_likes)))


if __name__ == "__main__":
    main()
