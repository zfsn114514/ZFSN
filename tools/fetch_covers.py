# -*- coding: utf-8 -*-
"""
下载 B站 视频封面到本地，绕过 CDN 防盗链。

B站图片 CDN 会检查 Referer，不带正确的值就返回 403 / 000。
用法：python fetch_covers.py
  读取站点根目录的 bili_videos.json，把封面存到 <站点根>/assets/bili/
"""
import json
import os
import time
import urllib.request
import urllib.error

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"),
    "Referer": "https://www.bilibili.com/",     # 必须是 www，不是 space
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
}

HOSTS = ["i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com"]


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


def try_download(url):
    """依次尝试 i0 / i1 / i2 三个子域，任一成功即返回图片字节。"""
    if not url:
        return None
    url = url.replace("http://", "https://")
    if url.startswith("//"):
        url = "https:" + url
    for host in HOSTS:
        u = url
        for h in HOSTS:
            u = u.replace("//" + h, "//" + host)
        try:
            req = urllib.request.Request(u, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=25) as r:
                blob = r.read()
            # 防盗链有时返回小体积错误页而不是 4xx，用体积兜底
            if len(blob) > 1000:
                return blob
        except Exception as e:
            print("      {} 失败: {}".format(host, e))
    return None


def main():
    here = site_root()
    data_path = os.path.join(here, "bili_videos.json")
    out_dir = os.path.join(here, "assets", "bili")

    print("站点根目录: {}".format(here))
    if not os.path.exists(data_path):
        print("找不到 {}，请先运行 build_bili.py".format(data_path))
        return
    os.makedirs(out_dir, exist_ok=True)

    with open(data_path, "r", encoding="utf-8") as f:
        d = json.load(f)

    videos = d.get("videos", [])
    ok = 0
    for i, v in enumerate(videos):
        src = v.get("coverUrl") or v.get("cover") or ""

        # 已本地化且文件存在 -> 跳过
        if src.startswith("assets/"):
            p = os.path.join(here, src.replace("/", os.sep))
            if os.path.exists(p):
                print("[{}/{}] 已存在  {}".format(i + 1, len(videos), src))
                ok += 1
                continue
        if not src:
            print("[{}/{}] 跳过（无封面地址）".format(i + 1, len(videos)))
            continue

        print("[{}/{}] 下载 {} ...".format(i + 1, len(videos), v.get("bvid", "?")))
        blob = try_download(src)
        if blob:
            fn = "assets/bili/{}.jpg".format(v.get("bvid") or "cover{}".format(i))
            with open(os.path.join(here, fn.replace("/", os.sep)), "wb") as f:
                f.write(blob)
            v["cover"] = fn          # 改成相对路径，前端直接读
            v["coverUrl"] = src      # 保留原始地址，便于下次复用
            ok += 1
            print("      OK  {} ({:,} bytes)".format(fn, len(blob)))
        else:
            print("      全部子域失败，保留空封面")
        time.sleep(1.2)

    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)

    print("\n完成：{}/{} 张封面已本地化".format(ok, len(videos)))
    print("-> {}".format(data_path))


if __name__ == "__main__":
    main()
