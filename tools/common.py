# -*- coding: utf-8 -*-
"""
tools 公共工具
================================================
所有数据脚本共用的小工具，避免每个文件复制一遍。

为什么要有这个模块：
    之前 site_root() / http_get() 这类函数在 5 个脚本里各写了一份，
    改一处漏四处。集中到这里之后只有一份实现。

用法：
    import common
    here = common.site_root()
    cfg  = common.load_config()
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

# 默认 UA：部分站点（B站 / Steam）对无 UA 的请求直接拒绝
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

CONFIG_NAME = "config.json"


# ──────────────────────────────────────────────────────────
#  路径
# ──────────────────────────────────────────────────────────

def site_root():
    """定位站点根目录（存放 index.html 的地方）。

    脚本可能被放在站点根目录，也可能放在 tools/ 子目录，两种都要能工作。
    优先用环境变量 SITE_ROOT，便于迁移。
    """
    env = os.environ.get("SITE_ROOT")
    if env and os.path.exists(os.path.join(env, "index.html")):
        return os.path.abspath(env)

    here = os.path.dirname(os.path.abspath(__file__))
    # 脚本在 tools/ 下 → 站点根在上一级
    parent = os.path.dirname(here)
    if os.path.exists(os.path.join(parent, "index.html")):
        return parent
    # 脚本被直接放在站点根
    if os.path.exists(os.path.join(here, "index.html")):
        return here
    return here  # 兜底


def tools_dir():
    """本模块所在目录（tools/）。"""
    return os.path.dirname(os.path.abspath(__file__))


# ──────────────────────────────────────────────────────────
#  配置
# ──────────────────────────────────────────────────────────

def load_config():
    """读取 tools/config.json。

    支持用环境变量覆盖敏感项，这样把脚本给别人用的时候
    不必把 key 写进文件：
        STEAM_API_KEY / STEAM_ID / SITE_ROOT
    """
    path = os.path.join(tools_dir(), CONFIG_NAME)
    cfg = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            print("[warn] config.json 解析失败，改用内置默认值: {}".format(e))
    else:
        print("[warn] 未找到 {}，使用内置默认值".format(path))

    steam = cfg.setdefault("steam", {})
    if os.environ.get("STEAM_API_KEY"):
        steam["api_key"] = os.environ["STEAM_API_KEY"]
    if os.environ.get("STEAM_ID"):
        steam["steamid"] = os.environ["STEAM_ID"]
    return cfg


# ──────────────────────────────────────────────────────────
#  HTTP
# ──────────────────────────────────────────────────────────

def http_get(url, headers=None, timeout=20, retry=3, quiet=False,
             no_retry_codes=(400, 401, 403, 404)):
    """带重试的 GET，返回 bytes。

    重试策略：线性退避（2s / 4s / 6s…）。
    ⚠ 别在外面再套一层重试循环 —— 会变成乘法关系，
      最坏情况要等好几分钟（这个坑踩过一次）。

    no_retry_codes: 遇到这些 HTTP 状态码直接放弃，不重试。
        默认把 4xx 全算作"确定性失败"。
        但有些接口的 403 是临时风控（比如微软 catalog），
        那种情况传 no_retry_codes=(404,) 让它继续重试。
    """
    last = None
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)

    for attempt in range(retry):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in no_retry_codes:
                break
        except Exception as e:
            last = e
        if attempt < retry - 1:
            wait = 2 * (attempt + 1)
            if not quiet:
                print("      请求失败({})，{}s 后重试…".format(str(last)[:60], wait))
            time.sleep(wait)
    raise last


def http_json(url, headers=None, timeout=20, retry=3, quiet=False):
    """GET 并解析 JSON。"""
    raw = http_get(url, headers=headers, timeout=timeout, retry=retry, quiet=quiet)
    return json.loads(raw.decode("utf-8", "ignore"))


# ──────────────────────────────────────────────────────────
#  格式化 / 写盘
# ──────────────────────────────────────────────────────────

def hours_text(mins):
    """分钟 -> 可读时长字符串。"""
    try:
        mins = int(mins or 0)
    except (TypeError, ValueError):
        return "未玩过"
    if mins <= 0:
        return "未玩过"
    if mins < 60:
        return "{} 分钟".format(mins)
    h = mins / 60.0
    if h < 100:
        return "{:.1f} 小时".format(h)
    return "{:,} 小时".format(int(round(h)))


def now_stamp():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def write_json(path, obj, indent=2):
    """原子写 JSON —— 先写 .tmp 再替换。

    为什么不用直接 open(w)：写到一半崩溃 / 被中断会留下半个文件，
    下次读取直接解析失败，站点数据就"坏"了。
    """
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)
    return path


def read_json(path, fallback=None):
    if not os.path.exists(path):
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print("[warn] {} 解析失败: {}".format(path, e))
        return fallback


# ──────────────────────────────────────────────────────────
#  输出
# ──────────────────────────────────────────────────────────

def banner(title):
    print()
    print("=" * 52)
    print("  " + title)
    print("=" * 52)
    print()
    sys.stdout.flush()


def step(idx, total, text):
    print()
    print("-" * 52)
    print("[{}/{}] {}".format(idx, total, text))
    print("-" * 52)
    sys.stdout.flush()
