# -*- coding: utf-8 -*-
"""
抓取 Xbox 游戏封面 —— 走微软官方 displaycatalog API。

数据来源：
    https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/Games/products
    ?query=<游戏名>&market=CN&languages=zh-cn&fieldsTemplate=Details

流程：
    1. 读 xbox_games.json 里的游戏名
    2. 用游戏名 + 别名逐个搜索，取最匹配的结果
    3. 从 Images 里取 BoxArt / Poster / Logo 图
    4. 下载到 assets/xbox/<appid>.jpg
    5. 回写 cover 字段

用法：
    python build_xbox_covers.py
"""
import json
import os
import re
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

CATALOG = ("https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/Games/products"
           "?query={}&market=CN&languages=zh-cn&fieldsTemplate=Details")

# 优先取图的顺序（Xbox 卡片用竖版海报最好看，其次 BoxArt）
IMG_ORDER = ["Poster", "BoxArt", "BrandedKeyArt", "FeaturePromotionalSquareArt", "Logo", "Image"]

# 微软 catalog 的请求头
HEADERS = {
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept": "application/json,text/html,*/*",
}


def site_root():
    """定位站点根目录。实现已统一到 common.site_root()，这里只做转发。"""
    return common.site_root()


def http_get(url, timeout=20, retry=3):
    """GET 返回 bytes。

    走 common.http_get，但把「不重试」的状态码放宽到只有 404 ——
    微软 catalog 偶尔会返回临时 403，那种情况值得重试。
    """
    return common.http_get(url, headers=HEADERS, timeout=timeout, retry=retry,
                           quiet=True, no_retry_codes=(404,))


def search(name):
    """搜索商品，返回产品列表。"""
    url = CATALOG.format(urllib.parse.quote(name))
    raw = http_get(url)
    d = json.loads(raw.decode("utf-8", "ignore"))
    return d.get("Products", []) or []


def pick_image(product):
    """从产品里挑一张最好的封面图，返回 (url, 类型)。"""
    imgs = product.get("LocalizedProperties", [{}])[0].get("Images", []) or []
    if not imgs:
        return None, None
    by_purpose = {}
    for im in imgs:
        p = (im.get("ImagePurpose") or "").strip()
        u = im.get("Uri") or ""
        if not u:
            continue
        # 只保留较大的图（避开 32x32 小图标）
        if im.get("Width") and im["Width"] < 150:
            continue
        # 同类型保留宽度最大的
        if p not in by_purpose or (im.get("Width") or 0) > (by_purpose[p].get("Width") or 0):
            by_purpose[p] = im
    for p in IMG_ORDER:
        if p in by_purpose:
            return by_purpose[p]["Uri"], p
    # 没命中预设顺序就随便取一张最大的
    best = max(by_purpose.values(), key=lambda x: x.get("Width") or 0, default=None)
    if best:
        return best["Uri"], best.get("ImagePurpose") or "Image"
    return None, None


def score(name, product):
    """判断搜索结果与目标名字的相似度（越大越像）。"""
    props = product.get("LocalizedProperties", [{}])[0]
    title = (props.get("ProductTitle") or "").strip()
    if not title:
        return -999
    a = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", name.lower())
    b = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", title.lower())
    if not a or not b:
        return -999
    s = 0
    if a == b:
        s = 100
    elif a in b or b in a:
        s = 60
    else:
        # 词重合度
        wa = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", name.lower()))
        wb = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", title.lower()))
        common = wa & wb
        s = len(common) * 12
    # 游戏类优先
    if (product.get("ProductKind") or "").lower() == "game":
        s += 8
    return s


def main():
    here = site_root()
    data_path = os.path.join(here, "xbox_games.json")
    out_dir = os.path.join(here, "assets", "xbox")
    os.makedirs(out_dir, exist_ok=True)

    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    games = data.get("games", [])
    print("站点根目录: {}".format(here))
    print("待处理 {} 款游戏\n".format(len(games)))

    ok = 0
    for i, g in enumerate(games, 1):
        appid = g.get("appid") or ("xbox-%d" % i)
        name = g.get("name") or ""
        # 搜索时去掉平台后缀，命中率更高
        q = re.sub(r"\s*[-—(（].*$", "", name).strip() or name

        print("[{:2}/{}] {}".format(i, len(games), name))
        try:
            prods = search(q)
        except Exception as e:
            print("       搜索失败: {}".format(str(e)[:70]))
            continue

        if not prods:
            print("       无结果")
            continue

        prods.sort(key=lambda p: -score(q, p))
        chosen = prods[0]
        title = chosen.get("LocalizedProperties", [{}])[0].get("ProductTitle", "?")
        url, purpose = pick_image(chosen)
        if not url:
            print("       最匹配: {} -> 无图片".format(title))
            continue

        # 微软返回的 Uri 是协议相对地址（//store-images...），补上 https:
        if url.startswith("//"):
            url = "https:" + url
        elif url.startswith("/"):
            url = "https://displaycatalog.mp.microsoft.com" + url

        # 下载
        try:
            blob = http_get(url, timeout=25)
        except Exception as e:
            print("       下载失败: {}".format(str(e)[:70]))
            continue

        if len(blob) < 1500:
            print("       图片过小({} 字节)，跳过".format(len(blob)))
            continue

        ext = ".jpg"
        if url.lower().endswith(".png"):
            ext = ".png"
        rel = "assets/xbox/{}{}".format(appid, ext)
        dst = os.path.join(here, rel.replace("/", os.sep))
        with open(dst, "wb") as f:
            f.write(blob)

        g["cover"] = rel
        g["coverSource"] = purpose
        g["matchedTitle"] = title
        ok += 1
        print("       OK  {}  <- {} ({}, {} KB)".format(
            rel, title, purpose, round(len(blob) / 1024)))
        time.sleep(0.4)

    data["coverCount"] = ok
    data["coversUpdated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print("\n成功获取 {}/{} 张封面 -> {}".format(ok, len(games), data_path))


if __name__ == "__main__":
    main()
