# -*- coding: utf-8 -*-
"""
拉取 ZFSN（UID 1220210222）的 B站 完整数据：
  · 全部投稿（自动分页）
  · 每条视频的完整互动数据（播放/弹幕/评论/点赞/投币/收藏/分享）
  · 账号总览（昵称/头像/签名/等级/粉丝/关注/总播放/总获赞）

B站 接口要点（实测结论，改动前请先读）：
  · space 列表走 wbi 签名，且对频率极敏感 —— 连续快速请求必 412。
    必须：预热 cookie → 签名 → 每页之间 sleep 3~5s → 遇 412 指数退避重试。
  · /x/web-interface/card 已风控（-352），不要用。粉丝数改用 /x/relation/stat。
  · /x/space/upstat 返回 data={} 属正常（该账号无累计数据或接口变更），
    不要当成失败；总播放量改由本地各视频播放数求和兜底。
  · /x/web-interface/view 是单个视频的万能接口，stat/tname/duration 都在里面。

输出：bili_videos.json
  {
    "mid", "space", "updated", "count",
    "profile": { name, face, sign, level, followers, following, likes, birthday, jointime, ... },
    "videos": [ { bvid, aid, title, cover, pub, length, duration, tname, desc,
                  views, danmaku, reply, like, coin, favorite, share, tags } ]
  }
"""
import json
import time
import hashlib
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar
import os
import sys

# 立刻输出而不等缓冲区满 —— 否则重定向到日志文件时看不到任何进度
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

MID = 1220210222

# 单页条数。B站 空间接口上限 50，但值越大越容易触发风控，20 比较稳。
PAGE_SIZE = 20
# 分页之间的强制间隔（秒）。B站 对同 IP 连续请求极敏感，宁可慢也别被封。
PAGE_DELAY = 8.0
# 单视频详情接口之间的间隔（秒）。
DETAIL_DELAY = 2.0
# 最多抓多少条投稿（0 = 不限制）
MAX_VIDEOS = 0
# 每抓 N 条详情就多歇一会儿，进一步降低风控概率
DETAIL_REST_EVERY = 10
DETAIL_REST_SEC = 12.0

MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def site_root():
    """定位站点根目录（存放 index.html 的地方）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "index.html")):
        return here
    parent = os.path.dirname(here)
    if os.path.exists(os.path.join(parent, "index.html")):
        return parent
    return here


def relogin():
    """重新获取 buvid cookie。412 风控后单纯等待往往没用，换新 cookie 更有效。"""
    try:
        get("https://www.bilibili.com/", retry=1)
        d = json.loads(get("https://api.bilibili.com/x/frontend/finger/spi", retry=1))
        if d.get("code") == 0 and d.get("data"):
            dd = d["data"]
            for name, val in (("buvid3", dd.get("b_3")), ("buvid4", dd.get("b_4"))):
                if val:
                    cj.set_cookie(http.cookiejar.Cookie(
                        version=0, name=name, value=val, port=None, port_specified=False,
                        domain=".bilibili.com", domain_specified=True, domain_initial_dot=True,
                        path="/", path_specified=True, secure=True, expires=None,
                        discard=False, comment=None, comment_url=None, rest={}, rfc2109=False))
            return True
    except Exception:
        pass
    return False


def get(url, headers=None, timeout=20, retry=5, quiet=False, refresh_on_412=True):
    """GET + 风控退避重试。

    ⚠ 关于 412 的现实（实测结论，别抱幻想）：
      412 是**纯 IP 级封禁**，只打 space 列表这一个接口，其他接口都正常。
      换 UA 完全无效（Chrome/Edge/手机 Chrome 三种 UA 全被 412）。
      重试次数给太多只会让脚本空转几分钟然后一样失败 —— 所以在
      space 列表这种"本来就可能被长期封"的调用上，用 retry=2 快速失败更好，
      把额度留给 view / relation/stat 这些还能用的接口。
    """
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://space.bilibili.com/{}/".format(MID),
        "Origin": "https://space.bilibili.com",
        "Connection": "keep-alive",
    }
    if headers:
        h.update(headers)
    last = None
    for attempt in range(retry):
        try:
            req = urllib.request.Request(url, headers=h)
            with opener.open(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (412, 429, 503):
                # 最后一次不再等待，直接抛出（避免无谓的末尾 sleep）
                if attempt == retry - 1:
                    break
                wait = 10 * (attempt + 1)
                if not quiet:
                    print("      [{}] 风控限流，等待 {}s{}…".format(
                        e.code, wait, "并刷新 cookie" if refresh_on_412 else "后重试"))
                time.sleep(wait)
                # 412 通常是 cookie 被判失效，换一套新的往往立刻恢复
                if refresh_on_412 and e.code == 412 and attempt >= 1:
                    relogin()
                continue
            raise
    raise last


def mixin_key_of(img_key, sub_key):
    return "".join((img_key + sub_key)[i] for i in MIXIN_TAB)[:32]


def signed(url_base, params, mk):
    """按 B站 wbi 规则签名：参数排序 → wts → md5(query + mixin_key)。"""
    p = dict(params)
    p["wts"] = str(int(time.time()))
    p = dict(sorted(p.items()))
    query = urllib.parse.urlencode(p)
    p["w_rid"] = hashlib.md5((query + mk).encode()).hexdigest()
    return url_base + "?" + urllib.parse.urlencode(p)


def num(v, default=0):
    try:
        n = int(v)
        return n
    except (TypeError, ValueError):
        return default


def fmt_count(n):
    """12345 -> 1.2万；1.23亿。前端展示更友好。"""
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


def hms_to_sec(text):
    """'12:34' -> 754 ；'1:02:03' -> 3723。列表接口的 length 字段用这个解析。"""
    parts = [num(p) for p in str(text or "").split(":") if p.strip() != ""]
    if not parts:
        return 0
    sec = 0
    for p in parts:
        sec = sec * 60 + p
    return sec


def main():
    t0 = time.time()
    here = site_root()

    # ── 0. cookie 预热 ──
    # B站 风控会检查 buvid3。被动等首页 Set-Cookie 不太可靠，
    # 更稳的做法是主动调 spi 接口拿 b_3（就是 buvid3）并写进 cookie jar。
    try:
        get("https://www.bilibili.com/")
        d = json.loads(get("https://api.bilibili.com/x/frontend/finger/spi"))
        if d.get("code") == 0 and d.get("data"):
            dd = d["data"]
            for name, val in (("buvid3", dd.get("b_3")), ("buvid4", dd.get("b_4"))):
                if val:
                    cj.set_cookie(http.cookiejar.Cookie(
                        version=0, name=name, value=val, port=None, port_specified=False,
                        domain=".bilibili.com", domain_specified=True, domain_initial_dot=True,
                        path="/", path_specified=True, secure=True, expires=None,
                        discard=False, comment=None, comment_url=None, rest={}, rfc2109=False))
        print("[0] cookie 预热完成：{}".format(", ".join(c.name for c in cj)))
    except Exception as e:
        print("[0] 预热失败（继续尝试）: {}".format(e))
        try:
            get("https://space.bilibili.com/{}".format(MID))
            print("[0] 已退回空间页预热：{}".format(", ".join(c.name for c in cj)))
        except Exception as e2:
            print("[0] 预热彻底失败: {}".format(e2))

    # ── 1. wbi 密钥 ──
    nav = json.loads(get("https://api.bilibili.com/x/web-interface/nav"))
    wbi = (nav.get("data") or {}).get("wbi_img")
    if not wbi:
        print("[1] 未能取得 wbi 密钥，终止")
        return
    ik = wbi["img_url"].rsplit("/", 1)[1].split(".")[0]
    sk = wbi["sub_url"].rsplit("/", 1)[1].split(".")[0]
    mk = mixin_key_of(ik, sk)
    print("[1] wbi 密钥就绪")

    # ── 2. 分页抓取全部投稿 ──
    # 注意：-352 / -412 是 B站 的业务层风控码，会带着 HTTP 200 一起返回，
    # 所以不能只靠 HTTP 层的重试，必须在解析后单独判断并退避。
    print("[2] 开始抓取投稿列表…")
    raw_list = []
    page = 1
    total = None
    while True:
        url = signed(
            "https://api.bilibili.com/x/space/wbi/arc/search",
            {
                "mid": str(MID),
                "ps": str(PAGE_SIZE),
                "pn": str(page),
                "order": "pubdate",
                "platform": "web",
                "web_location": "1550101",
            },
            mk,
        )

        d = None
        # ⚠ 这里绝不能和 get() 内部的 retry 叠加！
        #   曾写成 for attempt in range(5) 且 get() 默认 retry=5 →
        #   最坏情况 5×5=25 次请求、退避时间指数叠加，脚本会静默空转好几分钟
        #   （外层还有 8*(attempt+1) 的 sleep），排查时极易误判为"卡死"。
        #   现在：HTTP 层 retry=1（不在 get 里退避），业务层最多重签 3 次。
        for attempt in range(3):
            try:
                d = json.loads(get(url, retry=1, quiet=True))
            except Exception as e:
                print("      第 {} 页请求异常: {}".format(page, e))
                d = None
            code = (d or {}).get("code")
            if code == 0:
                break
            # 风控码：等一会儿并重新签名（wts 过期也会导致签名失效）
            if code in (-352, -412, -509):
                if attempt == 2:
                    break            # 最后一次不再等待
                wait = 6 * (attempt + 1)
                print("      第 {} 页风控 code={}，等待 {}s 后重签重试…".format(page, code, wait))
                time.sleep(wait)
                url = signed(
                    "https://api.bilibili.com/x/space/wbi/arc/search",
                    {
                        "mid": str(MID),
                        "ps": str(PAGE_SIZE),
                        "pn": str(page),
                        "order": "pubdate",
                        "platform": "web",
                        "web_location": "1550101",
                    },
                    mk,
                )
                continue
            break

        if not d or d.get("code") != 0 or not d.get("data"):
            print("      第 {} 页最终失败 code={} {}".format(
                page, (d or {}).get("code"), (d or {}).get("message", "")))
            if page == 1:
                print("      ⚠ 第一页就失败 = 当前 IP 被 B站 限流（space 列表接口）。")
                print("        实测：这是纯 IP 级封禁，换 UA 无效；")
                print("        但 view / relation/stat 走**独立限流池**，仍然可用 ——")
                print("        所以视频列表可沿用旧数据，只跑 build_bili_profile.py 补详情即可。")
            break

        data = d["data"]
        if total is None:
            total = num((data.get("page") or {}).get("count"))
            print("      接口报告投稿总数: {}".format(total))

        vlist = (data.get("list") or {}).get("vlist") or []
        if not vlist:
            break

        raw_list.extend(vlist)
        print("      第 {} 页 +{} 条（累计 {}）".format(page, len(vlist), len(raw_list)))

        if MAX_VIDEOS and len(raw_list) >= MAX_VIDEOS:
            raw_list = raw_list[:MAX_VIDEOS]
            break
        if total is not None and len(raw_list) >= total:
            break
        if len(vlist) < PAGE_SIZE:
            break

        page += 1
        time.sleep(PAGE_DELAY)

    if not raw_list:
        # ★ 优雅降级：列表抓不到时**绝不能**让已有数据丢失。
        #   历史经验：space 列表容易被长期封（几十分钟~几小时），
        #   而 bili_videos.json 里已有的视频完全可用。
        #   此时正确做法是保留旧列表，只提示用户去跑 build_bili_profile.py
        #   补互动数据（走 view 接口，独立限流池，通常仍可用）。
        print("\n[2] 未取得任何投稿 —— space 列表接口被风控（这是常见情况）")
        print("    ══════════════════════════════════════════════════")
        print("    现有 bili_videos.json **未被改动**，站点数据完好。")
        print("    可执行以下命令单独补齐账号信息与视频互动数据：")
        print("        python build_bili_profile.py")
        print("    （该脚本走 view / relation/stat 接口，与列表接口不同限流池）")
        print("    稍后（建议隔几小时或换网络）再重跑本脚本以获取全量投稿。")
        print("    ══════════════════════════════════════════════════")
        return
    print("[2] 共取得 {} 条投稿\n".format(len(raw_list)))

    # ── 3. 逐条补详情（互动数据 / 分区 / 秒数） ──
    print("[3] 抓取每条视频的详细数据（较慢，请耐心）…")
    cover_dir = os.path.join(here, "assets", "bili")
    os.makedirs(cover_dir, exist_ok=True)

    def grab_cover(url, bvid):
        """下载封面到本地 —— B站 CDN 有防盗链，必须带 Referer。"""
        if not url:
            return ""
        url = url.replace("http://", "https://")
        h = {"User-Agent": UA, "Referer": "https://www.bilibili.com/",
             "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}
        for host in ("i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"):
            try:
                u = url.replace("//i0.hdslb.com", "//" + host)
                req = urllib.request.Request(u, headers=h)
                with urllib.request.urlopen(req, timeout=20) as r:
                    blob = r.read()
                if len(blob) < 800:
                    continue
                fn = "assets/bili/{}.jpg".format(bvid)
                with open(os.path.join(here, fn.replace("/", os.sep)), "wb") as f:
                    f.write(blob)
                return fn
            except Exception:
                continue
        return ""

    videos = []
    for i, v in enumerate(raw_list, 1):
        bvid = v.get("bvid", "")
        aid = v.get("aid", 0)
        title = v.get("title", "")
        print("    [{}/{}] {}".format(i, len(raw_list), title[:36]))

        item = {
            "bvid": bvid,
            "aid": aid,
            "title": title,
            "cover": grab_cover(v.get("pic") or "", bvid),
            "coverUrl": (v.get("pic") or "").replace("http://", "https://"),
            "pub": time.strftime("%Y-%m-%d", time.localtime(v.get("created", 0))),
            "ts": num(v.get("created")),
            "length": v.get("length", ""),
            "duration": hms_to_sec(v.get("length", "")),
            "desc": (v.get("description") or "")[:200],
            # 列表页就有的基础数据（详情接口失败时兜底）
            "views": num(v.get("play", 0)),
            "danmaku": num(v.get("video_review", 0)),
            "reply": 0, "like": 0, "coin": 0, "favorite": 0, "share": 0,
            "tname": v.get("typename", ""),
        }

        # 详情接口：拿到完整 stat（风控时退避重试）
        for attempt in range(3):
            try:
                d = json.loads(get(
                    "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid,
                    retry=2, quiet=True))
            except Exception as e:
                print("        详情请求异常: {}".format(e))
                d = None
            code = (d or {}).get("code")
            if code == 0:
                break
            if code in (-352, -412, -509):
                time.sleep(6 * (attempt + 1))
                continue
            break

        try:
            if d and d.get("code") == 0 and d.get("data"):
                dd = d["data"]
                st = dd.get("stat") or {}
                item["views"] = num(st.get("view", item["views"]))
                item["danmaku"] = num(st.get("danmaku", item["danmaku"]))
                item["reply"] = num(st.get("reply"))
                item["like"] = num(st.get("like"))
                item["coin"] = num(st.get("coin"))
                item["favorite"] = num(st.get("favorite"))
                item["share"] = num(st.get("share"))
                item["tname"] = (dd.get("tname") or item["tname"]).strip()
                item["duration"] = num(dd.get("duration", item["duration"]))
                item["length"] = sec_to_hms(item["duration"])
                if dd.get("desc"):
                    item["desc"] = dd["desc"][:200]
                # 多P视频标记
                item["pages"] = num(dd.get("videos", 1))
                print("        播放 {} | 赞 {} | 币 {} | 藏 {} | 弹幕 {}".format(
                    fmt_count(item["views"]), fmt_count(item["like"]),
                    fmt_count(item["coin"]), fmt_count(item["favorite"]),
                    fmt_count(item["danmaku"])))
            else:
                print("        详情未取到（用列表数据兜底）")
        except Exception as e:
            print("        详情失败（用列表数据兜底）: {}".format(e))

        videos.append(item)
        if i < len(raw_list):
            time.sleep(DETAIL_DELAY)
            # 每若干条多歇一下，避免被判定为爬虫
            if i % DETAIL_REST_EVERY == 0:
                print("        （已抓 {} 条，休息 {:.0f}s 让风控冷却…）".format(i, DETAIL_REST_SEC))
                time.sleep(DETAIL_REST_SEC)

    # ── 4. 账号总览 ──
    print("\n[4] 抓取账号总览…")
    profile = {
        "mid": MID,
        "name": "",
        "face": "",
        "sign": "",
        "level": 0,
        "followers": 0,
        "following": 0,
        "likes": 0,
        "birthday": "",
        "jointime": "",
    }

    # 4.1 基本信息（acc/info 实测可用）
    try:
        d = json.loads(get("https://api.bilibili.com/x/space/acc/info?mid={}".format(MID),
                           retry=3, quiet=True))
        if d.get("code") == 0 and d.get("data"):
            dd = d["data"]
            profile["name"] = dd.get("name", "")
            profile["face"] = (dd.get("face") or "").replace("http://", "https://")
            profile["sign"] = dd.get("sign", "")
            profile["level"] = num((dd.get("level_info") or {}).get("current_level",
                                    dd.get("level")))
            jt = num(dd.get("jointime"))
            if jt:
                profile["jointime"] = time.strftime("%Y-%m-%d", time.localtime(jt))
            profile["birthday"] = dd.get("birthday", "")
            print("      昵称={} 等级=Lv{}".format(profile["name"], profile["level"]))
    except Exception as e:
        print("      acc/info 失败: {}".format(e))

    time.sleep(1.5)

    # 4.2 粉丝 / 关注（relation/stat 实测可用）
    try:
        d = json.loads(get("https://api.bilibili.com/x/relation/stat?vmid={}".format(MID),
                           retry=3, quiet=True))
        if d.get("code") == 0 and d.get("data"):
            profile["followers"] = num(d["data"].get("follower"))
            profile["following"] = num(d["data"].get("following"))
            print("      粉丝={} 关注={}".format(profile["followers"], profile["following"]))
    except Exception as e:
        print("      relation/stat 失败: {}".format(e))

    time.sleep(1.5)

    # 4.3 累计获赞（upstat；该账号可能返回空对象，属正常）
    try:
        d = json.loads(get("https://api.bilibili.com/x/space/upstat?mid={}".format(MID),
                           retry=3, quiet=True))
        if d.get("code") == 0 and d.get("data"):
            dd = d["data"]
            profile["likes"] = num((dd.get("likes") or {}).get("total", dd.get("likes", 0)))
            if profile["likes"]:
                print("      累计获赞={}".format(profile["likes"]))
        else:
            print("      upstat 无数据（正常），改用本地求和兜底")
    except Exception as e:
        print("      upstat 失败: {}".format(e))

    # 4.4 本地兜底统计（无论接口是否成功，都给出一份可展示的汇总）
    total_views = sum(v["views"] for v in videos)
    total_likes = sum(v["like"] for v in videos)
    total_coins = sum(v["coin"] for v in videos)
    total_fav = sum(v["favorite"] for v in videos)
    total_dm = sum(v["danmaku"] for v in videos)
    total_reply = sum(v["reply"] for v in videos)
    total_sec = sum(v["duration"] for v in videos)

    if not profile["likes"]:
        profile["likes"] = total_likes
    profile["total_views"] = total_views
    profile["total_likes"] = total_likes
    profile["total_coins"] = total_coins
    profile["total_favorites"] = total_fav
    profile["total_danmaku"] = total_dm
    profile["total_replies"] = total_reply
    profile["total_duration"] = total_sec

    # 展示用格式化字符串
    profile["followers_text"] = fmt_count(profile["followers"])
    profile["likes_text"] = fmt_count(profile["likes"])
    profile["total_views_text"] = fmt_count(total_views)

    # ── 5. 输出 ──
    # 先写临时文件，成功后再原子替换 —— 避免抓取中途失败把旧数据毁掉
    videos.sort(key=lambda x: x.get("ts", 0), reverse=True)
    out = {
        "mid": MID,
        "space": "https://space.bilibili.com/{}".format(MID),
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(videos),
        "profile": profile,
        "videos": videos,
    }
    path = os.path.join(here, "bili_videos.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 顺手把头像也存到本地（B站 头像同样有防盗链）
    if profile.get("face"):
        try:
            req = urllib.request.Request(profile["face"], headers={
                "User-Agent": UA, "Referer": "https://www.bilibili.com/",
            })
            with urllib.request.urlopen(req, timeout=20) as r:
                blob = r.read()
            if len(blob) > 800:
                av = os.path.join(here, "assets", "bili_avatar.jpg")
                with open(av, "wb") as f:
                    f.write(blob)
                profile["face_local"] = "assets/bili_avatar.jpg"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(out, f, ensure_ascii=False, indent=2)
                print("[5] 头像已保存 assets/bili_avatar.jpg")
        except Exception as e:
            print("[5] 头像下载失败: {}".format(e))

    os.replace(tmp, path)

    print("\n[6] 写出 {} 条投稿 -> {}".format(len(videos), path))
    print("    总播放 {} | 总点赞 {} | 总时长 {:.1f} 小时".format(
        fmt_count(total_views), fmt_count(total_likes), total_sec / 3600))
    print("    耗时 {:.1f} 秒".format(time.time() - t0))


if __name__ == "__main__":
    main()
