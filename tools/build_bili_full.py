# -*- coding: utf-8 -*-
"""由 tools/.cache/bili_list.json（CDP 抓到的 108 条全量投稿）构建站点用的 bili_videos.json。

与旧的 build_bili.py 的分工：
  · build_bili.py       —— 自己抓列表（走 arc/search，本机 IP 已被 412 封，**基本抓不到**）
  · fetch_bili_list_cdp.js —— 用真实 Chrome 抓列表（**现在唯一可靠的列表来源**）
  · 本脚本              —— 读上面的缓存，补互动数据 + 下载封面 + 写站点 JSON

为什么还要单独补互动数据：
  space 列表接口（vlist）只给 play / video_review / comment，
  **没有 like / coin / favorite / tname**，而这几个前端要展示。
  这几个字段只在 /x/web-interface/view 里，它走**独立限流池**，实测最稳。

用法：
  python tools/build_bili_full.py              # 全量（108 条详情，约 5 分钟）
  python tools/build_bili_full.py --no-detail  # 跳过详情，只用列表数据（秒级）
  python tools/build_bili_full.py --limit 5    # 只处理前 5 条（调试）

安全约定：**任何一步失败都不覆盖已有 bili_videos.json**，只在全部成功时原子替换。
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import http.cookiejar

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

MID = 1220210222
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
LIST_JSON = os.path.join(CACHE, "bili_list.json")
OUT = os.path.join(SITE, "bili_videos.json")

DETAIL_DELAY = 1.6      # 每条 view 之间的间隔
DETAIL_REST_EVERY = 15  # 每 N 条多歇一会儿
DETAIL_REST_SEC = 8.0

# B站 二级分区编号 → 名称。
# ⚠ 为什么需要这张表：
#   /x/web-interface/view 对本账号返回的 `tname` 是**空串**（108/108 全空），
#   但同一条响应里的 `tid` 是有值的。所以分区名只能本地映射。
#   编号取自 B站 公开分区表；下面只列了本账号实际出现过的 + 常见的一批。
#   加新条目时请核对，不要凭印象写。
TID_NAME = {
    17: "单机游戏", 172: "手机游戏", 136: "音游", 171: "电子竞技",
    173: "桌游棋牌", 65: "网络游戏", 121: "GMV", 1361: "音游",
    21: "日常", 138: "搞笑", 75: "动物圈", 161: "手工", 162: "绘画",
    76: "美食制作", 163: "运动", 164: "健身", 158: "穿搭",
    31: "翻唱", 30: "VOCALOID·UTAU", 59: "演奏", 130: "音乐综合",
    29: "音乐现场", 28: "原创音乐", 194: "电音",
    4: "游戏", 160: "生活", 3: "音乐",
    24: "MAD·AMV", 25: "MMD·3D", 26: "短片·手书·配音", 27: "综合",
    1: "动画", 5: "娱乐", 36: "科技", 95: "数码", 122: "野生技术协会",
    124: "趣味科普人文", 201: "科学科普", 39: "社科·法律·心理",
    181: "影视杂谈", 182: "影视剪辑",
}

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def get(url, referer=None, timeout=20, retry=3, quiet=False):
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": referer or "https://space.bilibili.com/{}/".format(MID),
    }
    last = None
    for attempt in range(retry):
        try:
            req = urllib.request.Request(url, headers=h)
            with opener.open(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (412, 429, 503) and attempt < retry - 1:
                w = 5 * (attempt + 1)
                if not quiet:
                    print("        [{}] 限流，等 {}s…".format(e.code, w))
                time.sleep(w)
                continue
            raise
        except Exception as e:
            last = e
            if attempt < retry - 1:
                time.sleep(3)
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


def warmup():
    """预热 cookie：主动取 buvid3/buvid4 写进 jar，比等首页 Set-Cookie 稳。"""
    try:
        get("https://www.bilibili.com/", retry=1)
        d = json.loads(get("https://api.bilibili.com/x/frontend/finger/spi", retry=1))
        if d.get("code") == 0 and d.get("data"):
            for name, val in (("buvid3", d["data"].get("b_3")), ("buvid4", d["data"].get("b_4"))):
                if val:
                    cj.set_cookie(http.cookiejar.Cookie(
                        0, name, val, None, False, ".bilibili.com", True, True,
                        "/", True, True, None, False, None, None, {}, False))
        print("[预热] cookies = {}".format([c.name for c in cj]))
    except Exception as e:
        print("[预热] 失败（继续）: {}".format(e))


def grab_cover(url, bvid):
    """下载封面到 assets/bili/{bvid}.jpg。B站 CDN 有防盗链，必须带 Referer，三个子域轮询。"""
    if not url:
        return ""
    fn = "assets/bili/{}.jpg".format(bvid)
    dst = os.path.join(SITE, fn.replace("/", os.sep))
    # 已存在且体积正常就跳过，省流量也省时间
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return fn
    url = url.replace("http://", "https://")
    h = {"User-Agent": UA, "Referer": "https://www.bilibili.com/",
         "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}
    for host in ("i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"):
        try:
            u = url.replace("//i0.hdslb.com", "//" + host)
            req = urllib.request.Request(u, headers=h)
            with urllib.request.urlopen(req, timeout=25) as r:
                blob = r.read()
            if len(blob) < 800:      # 防盗链有时返回很小的错误页而非 4xx
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(blob)
            return fn
        except Exception:
            continue
    return ""


def fetch_profile(videos):
    """账号总览。

    字段来源优先级（实测得出的顺序）：
      1) m.bilibili.com/space/{mid} 的 SSR 数据 __INITIAL_STATE__.space.info
         —— 昵称/签名/等级/头像/生日 全在里面，而且**完全不走风控**，最可靠。
      2) /x/space/wbi/acc/info —— 经常 -352/-799，只当兜底。
      3) 已有的 bili_videos.json —— 最后兜底，避免把已有真实值刷成空。
      粉丝/关注 走 /x/relation/stat（独立限流池，稳）。
    """
    p = {
        "mid": MID, "name": "", "face": "", "sign": "", "level": 0,
        "followers": 0, "following": 0, "likes": 0,
    }

    # ── 1. H5 空间页 SSR ──
    try:
        h = {"User-Agent": ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"),
             "Accept": "text/html,application/xhtml+xml,*/*",
             "Accept-Language": "zh-CN,zh;q=0.9"}
        req = urllib.request.Request("https://m.bilibili.com/space/{}".format(MID), headers=h)
        with urllib.request.urlopen(req, timeout=20) as r:
            html = r.read().decode("utf-8", "ignore")
        m = re.search(r"__INITIAL_STATE__\s*=\s*(\{.*?\});", html, re.S)
        if m:
            st = json.loads(m.group(1).replace("undefined", "null"))
            info = ((st.get("space") or {}).get("info")) or {}
            p["name"] = info.get("name", "") or p["name"]
            p["sign"] = info.get("sign", "") or p["sign"]
            p["level"] = num(info.get("level"), p["level"])
            p["sex"] = info.get("sex", "")
            p["birthday"] = info.get("birthday", "")
            face = info.get("face") or ""
            if face:
                p["face"] = face.replace("http://", "https://")
            print("[账号] H5 页: {} Lv{} · {} · {}".format(
                p["name"], p["level"], p["sign"], p["sex"]))
    except Exception as e:
        print("[账号] H5 页失败: {}".format(e))

    # ── 2. acc/info 兜底 ──
    if not p["name"]:
        time.sleep(1.0)
        try:
            d = json.loads(get("https://api.bilibili.com/x/space/wbi/acc/info"
                               "?mid={}&platform=web&web_location=1550101".format(MID), quiet=True))
            if d.get("code") == 0 and d.get("data"):
                dd = d["data"]
                p["name"] = dd.get("name", "")
                p["face"] = (dd.get("face") or "").replace("http://", "https://")
                p["sign"] = dd.get("sign", "")
                p["level"] = num((dd.get("level_info") or {}).get("current_level", dd.get("level")))
                print("[账号] acc/info: {} Lv{}".format(p["name"], p["level"]))
            else:
                print("[账号] acc/info code={} {}（预期内，用 H5 的值）".format(
                    d.get("code"), d.get("message")))
        except Exception as e:
            print("[账号] acc/info 失败: {}".format(e))

    # ── 3. 已有 JSON 兜底（绝不把真实值刷成空） ──
    if not p["name"] and os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                old = (json.load(f) or {}).get("profile") or {}
            for k in ("name", "face", "sign", "level"):
                if not p.get(k) and old.get(k):
                    p[k] = old[k]
            if old.get("face_local"):
                p["face_local"] = old["face_local"]
            print("[账号] 用已有 bili_videos.json 兜底: {} Lv{}".format(p["name"], p["level"]))
        except Exception:
            pass

    time.sleep(1.2)
    try:
        d = json.loads(get("https://api.bilibili.com/x/relation/stat?vmid={}".format(MID), quiet=True))
        if d.get("code") == 0 and d.get("data"):
            p["followers"] = num(d["data"].get("follower"))
            p["following"] = num(d["data"].get("following"))
            print("[账号] 粉丝 {} / 关注 {}".format(p["followers"], p["following"]))
    except Exception as e:
        print("[账号] relation/stat 失败: {}".format(e))

    time.sleep(1.2)
    try:
        d = json.loads(get("https://api.bilibili.com/x/space/upstat?mid={}".format(MID), quiet=True))
        if d.get("code") == 0 and d.get("data"):
            dd = d["data"]
            p["likes"] = num((dd.get("likes") or {}).get("total", dd.get("likes", 0)))
            print("[账号] 累计获赞 {}".format(p["likes"]))
    except Exception as e:
        print("[账号] upstat 失败: {}".format(e))

    # 本地求和兜底
    p["total_views"] = sum(num(v.get("views")) for v in videos)
    p["total_likes"] = sum(num(v.get("like")) for v in videos)
    p["total_coins"] = sum(num(v.get("coin")) for v in videos)
    p["total_favorites"] = sum(num(v.get("favorite")) for v in videos)
    p["total_danmaku"] = sum(num(v.get("danmaku")) for v in videos)
    p["total_replies"] = sum(num(v.get("reply")) for v in videos)
    p["total_duration"] = sum(num(v.get("duration")) for v in videos)
    if not p["likes"]:
        p["likes"] = p["total_likes"]
    p["followers_text"] = fmt_count(p["followers"])
    p["likes_text"] = fmt_count(p["likes"])
    p["total_views_text"] = fmt_count(p["total_views"])
    return p


def load_existing():
    """读现有的 bili_videos.json（用于增量复用与兜底）。"""
    if not os.path.exists(OUT):
        return {}
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def load_typeid_map():
    """bvid -> typeid。优先用缓存列表里的，缺了再从原始响应里补。"""
    m = {}
    if os.path.exists(LIST_JSON):
        try:
            with open(LIST_JSON, encoding="utf-8") as f:
                for v in (json.load(f) or {}).get("videos") or []:
                    if v.get("typeid"):
                        m[v["bvid"]] = num(v["typeid"])
        except Exception:
            pass
    rawp = os.path.join(CACHE, "bili_raw_pages.json")
    if os.path.exists(rawp):
        try:
            with open(rawp, encoding="utf-8") as f:
                pages = (json.load(f) or {}).get("pages") or {}
            for p in pages.values():
                for v in p.get("vlist") or []:
                    if v.get("bvid") and v.get("typeid") and v["bvid"] not in m:
                        m[v["bvid"]] = num(v["typeid"])
        except Exception:
            pass
    return m


def main():
    no_detail = "--no-detail" in sys.argv
    # 增量：已有 JSON 里补过 like/coin/favorite 的条目直接复用，不再打 view 接口。
    # 用途是"只改封面/账号信息"时快速重建，避免白白烧风控额度。
    reuse = "--reuse-detail" in sys.argv
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    existing = load_existing()
    old_by_id = {}
    for v in existing.get("videos") or []:
        if v.get("bvid"):
            old_by_id[v["bvid"]] = v

    src = []
    if os.path.exists(LIST_JSON):
        with open(LIST_JSON, encoding="utf-8") as f:
            raw = json.load(f)
        src = raw.get("videos") or []
        print("[输入] 缓存列表 {} 条（页面声称 {} 条）".format(len(src), raw.get("total")))
    else:
        print("[输入] 找不到 {} —— 退回用现有 bili_videos.json 的列表".format(LIST_JSON))
        print("       想要**全量投稿**请先跑：node tools/fetch_bili_list_cdp.js")
        raw = {}
        src = [{"bvid": v["bvid"], "title": v.get("title", ""),
                "cover": v.get("coverUrl") or v.get("cover") or "",
                "pub": v.get("pub", ""), "ts": num(v.get("ts")),
                "length": v.get("length", ""), "duration": num(v.get("duration")),
                "desc": v.get("desc", ""), "views": num(v.get("views")),
                "danmaku": num(v.get("danmaku")), "reply": num(v.get("reply")),
                "pages": num(v.get("pages"), 1)} for v in existing.get("videos") or []]
    if not src:
        print("列表为空，终止（不覆盖已有数据）")
        return 1

    tid_map = load_typeid_map()

    warmup()

    videos = []
    for i, v in enumerate(src, 1):
        if limit and i > limit:
            break
        item = {
            "bvid": v["bvid"], "aid": num(v.get("aid")),
            "title": v.get("title", ""),
            "cover": "", "coverUrl": (v.get("cover") or "").replace("http://", "https://"),
            "pub": v.get("pub", ""), "ts": num(v.get("ts")),
            "length": v.get("length", ""), "duration": num(v.get("duration")),
            "desc": (v.get("desc") or "")[:200],
            "views": num(v.get("views")), "danmaku": num(v.get("danmaku")),
            "reply": num(v.get("reply")),
            "like": 0, "coin": 0, "favorite": 0, "share": 0,
            "typeid": num(v.get("typeid")) or tid_map.get(v["bvid"], 0),
            "tname": v.get("tname", ""), "pages": num(v.get("pages"), 1),
        }
        # 分区名：view 接口给不出，用本地表映射
        if not item["tname"] and item["typeid"]:
            item["tname"] = TID_NAME.get(item["typeid"], "")

        old = old_by_id.get(item["bvid"]) or {}

        # ── 增量复用 ──
        if reuse and old.get("like") is not None and old.get("coin") is not None and old.get("favorite") is not None \
                and (old.get("like") or old.get("coin") or old.get("favorite") or old.get("share")):
            for k in ("like", "coin", "favorite", "share", "views", "danmaku", "reply"):
                item[k] = num(old.get(k))
            if old.get("tname"):
                item["tname"] = old["tname"]
            item["cover"] = grab_cover(item.get("coverUrl") or "", item["bvid"])
            videos.append(item)
            continue

        # ── 详情接口：补 like/coin/favorite/share/精确时长 ──
        if not no_detail:
            print("  [{}/{}] {}".format(i, len(src), item["title"][:36]))
            d = None
            for attempt in range(3):
                try:
                    d = json.loads(get(
                        "https://api.bilibili.com/x/web-interface/view?bvid=" + item["bvid"],
                        retry=2, quiet=True))
                except Exception:
                    d = None
                code = (d or {}).get("code")
                if code == 0:
                    break
                if code in (-352, -412, -509):
                    time.sleep(5 * (attempt + 1))
                    continue
                break
            if d and d.get("code") == 0 and d.get("data"):
                dd = d["data"]
                st = dd.get("stat") or {}
                item["views"] = num(st.get("view"), item["views"])
                item["danmaku"] = num(st.get("danmaku"), item["danmaku"])
                item["reply"] = num(st.get("reply"), item["reply"])
                item["like"] = num(st.get("like"))
                item["coin"] = num(st.get("coin"))
                item["favorite"] = num(st.get("favorite"))
                item["share"] = num(st.get("share"))
                # 注意：dd.get("tname") 对本账号恒为空串，所以别用它覆盖本地映射
                if (dd.get("tname") or "").strip():
                    item["tname"] = dd["tname"].strip()
                elif dd.get("tid") and not item["tname"]:
                    item["tname"] = TID_NAME.get(num(dd["tid"]), "")
                if num(dd.get("duration")):
                    item["duration"] = num(dd["duration"])
                if dd.get("desc"):
                    item["desc"] = dd["desc"][:200]
                item["pages"] = num(dd.get("videos"), item["pages"])
                print("        播放 {} | 赞 {} | 币 {} | 藏 {} | {}".format(
                    fmt_count(item["views"]), fmt_count(item["like"]),
                    fmt_count(item["coin"]), fmt_count(item["favorite"]),
                    item["tname"] or "(无分区)"))
            else:
                print("        详情未取到（保留列表数据）")

        item["cover"] = grab_cover(item.get("coverUrl") or v.get("cover") or "", item["bvid"])
        videos.append(item)

        if not no_detail and i < len(src):
            time.sleep(DETAIL_DELAY)
            if i % DETAIL_REST_EVERY == 0:
                print("        （已 {} 条，休息 {:.0f}s）".format(i, DETAIL_REST_SEC))
                time.sleep(DETAIL_REST_SEC)

    if not videos:
        print("没有任何视频，终止")
        return 1

    # 封面缺失统计
    miss = [v["bvid"] for v in videos if not v["cover"]]
    print("\n[封面] {}/{} 下载成功".format(len(videos) - len(miss), len(videos)))
    if miss:
        print("       缺失: {}".format(", ".join(miss[:10])))

    profile = fetch_profile(videos)

    # 头像本地化
    if profile.get("face"):
        try:
            req = urllib.request.Request(profile["face"], headers={
                "User-Agent": UA, "Referer": "https://www.bilibili.com/"})
            with urllib.request.urlopen(req, timeout=20) as r:
                blob = r.read()
            if len(blob) > 800:
                with open(os.path.join(SITE, "assets", "bili_avatar.jpg"), "wb") as f:
                    f.write(blob)
                profile["face_local"] = "assets/bili_avatar.jpg"
                print("[头像] 已保存 assets/bili_avatar.jpg")
        except Exception as e:
            print("[头像] 下载失败: {}".format(e))

    videos.sort(key=lambda x: x.get("ts", 0), reverse=True)
    out = {
        "mid": MID,
        "space": "https://space.bilibili.com/{}".format(MID),
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(videos),
        "source": raw.get("source", ""),
        "profile": profile,
        "videos": videos,
    }

    # 原子替换：先写 .tmp 再 os.replace
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT)

    print("\n" + "=" * 58)
    print("写出 {} 条 -> {}".format(len(videos), OUT))
    print("总播放 {} | 总点赞 {} | 总时长 {:.1f} 小时".format(
        fmt_count(profile["total_views"]), fmt_count(profile["total_likes"]),
        profile["total_duration"] / 3600))
    print("=" * 58)
    return 0


if __name__ == "__main__":
    sys.exit(main())
