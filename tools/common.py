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
import re
import sys
import time
import urllib.request
import urllib.error

# 默认 UA：部分站点（B站 / Steam）对无 UA 的请求直接拒绝
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

CONFIG_NAME = "config.json"
CONFIG_EXAMPLE = "config.example.json"


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

    ★ config.json 里有 API Key，已在 .gitignore 里排除（曾经被提交过，
      导致旧 Steam Key 泄露并被 Steam 撤销）。新克隆的仓库只有
      config.example.json，这里会自动回退到它并给出提示。

    支持用环境变量覆盖敏感项，这样把脚本给别人用的时候
    不必把 key 写进文件：
        STEAM_API_KEY / STEAM_ID / SITE_ROOT
    """
    here = tools_dir()
    path = os.path.join(here, CONFIG_NAME)
    cfg = {}

    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            print("[warn] config.json 解析失败，改用内置默认值: {}".format(e))
    else:
        example = os.path.join(here, CONFIG_EXAMPLE)
        if os.path.exists(example):
            print("[warn] 未找到 config.json，暂用 config.example.json 的默认值。")
            print("       请复制一份并填上自己的配置：")
            print("         copy {} {}".format(CONFIG_EXAMPLE, CONFIG_NAME))
            with open(example, "r", encoding="utf-8") as f:
                cfg = json.load(f)
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
#  Valve KeyValues（VDF）
# ──────────────────────────────────────────────────────────
#  Steam 的配置全是这种类 JSON 格式。⚠ 花括号配对解析比正则可靠得多，
#  因为嵌套块用正则几乎不可能正确匹配。

def vdf_block(text, start):
    """从 start（应为 '{' 之后的第一个字符）找到配对的 '}'，返回块内文本。

    调用方式：
        i = text.index('"FamilyGroup"')
        j = text.index("{", i) + 1
        block = vdf_block(text, j)
    """
    depth = 1
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i]
        i += 1
    return text[start:]      # 括号不配对时退回剩余全文，至少不崩


def vdf_find_block(text, key):
    """找 `"key" { ... }` 并返回块内文本；找不到返回 None。"""
    needle = '"{}"'.format(key)
    i = text.find(needle)
    if i < 0:
        return None
    j = text.find("{", i + len(needle))
    if j < 0:
        return None
    return vdf_block(text, j + 1)


def vdf_unescape(s):
    """VDF 文本里一个反斜杠写两遍，读出来要还原。"""
    return s.replace("\\\\", "\\")


def vdf_str(block, key, default=""):
    """从块里取 `"key" "value"` 的字符串值。"""
    if not block:
        return default
    m = re.search(r'"' + re.escape(key) + r'"\s*"([^"]*)"', block)
    return m.group(1) if m else default


# ──────────────────────────────────────────────────────────
#  Steam 本机数据
# ──────────────────────────────────────────────────────────

# SteamID64 = accountid + 这个基数（Valve 的固定偏移）
STEAMID64_BASE = 76561197960265728


def steam_account_id(steamid64):
    """SteamID64 -> accountid（本机 userdata 目录名用的就是它）。"""
    return int(steamid64) - STEAMID64_BASE


def find_steam_root(cfg):
    """定位 Steam 安装目录。配置里的 steam_local.steam_root 优先，否则逐个探。"""
    cands = [(cfg.get("steam_local") or {}).get("steam_root")]
    cands += [
        "C:/Program Files (x86)/Steam",
        "C:/Program Files/Steam",
        "D:/Steam",
        "D:/Program Files (x86)/Steam",
        "D:/SteamLibrary",
        "E:/Steam",
    ]
    for c in cands:
        if c and os.path.exists(os.path.join(c, "config", "libraryfolders.vdf")):
            return c.replace("/", os.sep)
    return None


def read_login_users(steam_root):
    """读 config/loginusers.vdf -> {steamid64(int): PersonaName}。

    比问用户 SteamID 快得多：本机登录过的账号全在里面。
    """
    path = os.path.join(steam_root, "config", "loginusers.vdf")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    out = {}
    for m in re.finditer(r'"(\d{17})"\s*\{', text):
        blk = vdf_block(text, m.end())
        out[int(m.group(1))] = vdf_str(blk, "PersonaName")
    return out


def read_installed_apps(steam_root):
    """读 config/libraryfolders.vdf -> 各磁盘库里**已安装**的 appid 集合。

    ⚠ 只包含已安装的，不是"库里全部"。
    """
    path = os.path.join(steam_root, "config", "libraryfolders.vdf")
    if not os.path.exists(path):
        return set()
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    apps = set()
    for m in re.finditer(r'"apps"\s*\{', text):
        blk = vdf_block(text, m.end())
        apps |= {int(x) for x in re.findall(r'"(\d+)"\s+"', blk)}
    return apps


def read_playtimes(steam_root, account_id):
    """读 userdata/<accountid>/config/localconfig.vdf -> {appid: 分钟}。

    这是**本机记录的自己的游玩时长**，家庭共享游戏也在这里有记录
    （共享游戏不在 GetOwnedGames 里，所以这是唯一能拿到它们时长的途径）。
    """
    path = os.path.join(steam_root, "userdata", str(account_id),
                        "config", "localconfig.vdf")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    out = {}
    apps = vdf_find_block(text, "apps")
    if not apps:
        return out
    for m in re.finditer(r'"(\d{2,8})"\s*\{', apps):
        sub = vdf_block(apps, m.end())
        pt = vdf_str(sub, "Playtime")
        if pt.isdigit():
            out[int(m.group(1))] = int(pt)
    return out


def read_family_group(steam_root, account_id):
    """读 localconfig.vdf 的 FamilyGroup 块。

    返回 {groupid, name, role, members:[accountid,...]}；不在家庭组则返回 None。

    ★ 为什么必须从这里读成员名单：
      「谁是我的家庭成员」不能靠猜。本机 loginusers.vdf 里登录过的账号
      只是"用过这台电脑的账号"，跟家庭组完全无关 ——
      实测本机 6 个登录账号里只有 1 个在家庭组内，另 5 个各自属于别的家庭组。
    """
    path = os.path.join(steam_root, "userdata", str(account_id),
                        "config", "localconfig.vdf")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    blk = vdf_find_block(text, "FamilyGroup")
    if not blk:
        return None
    members = []
    mb = vdf_find_block(blk, "members")
    if mb:
        for m in re.finditer(r'"accountid"\s*"(\d+)"', mb):
            members.append(int(m.group(1)))
    if not members:
        return None
    return {
        "groupid": vdf_str(blk, "groupid"),
        "name": vdf_str(blk, "name"),
        "role": vdf_str(blk, "role"),
        "members": members,
    }


# ──────────────────────────────────────────────────────────
#  Steam Web API
# ──────────────────────────────────────────────────────────
#  ★★★ 关键：api.steampowered.com 的 443 在国内会被网络层重置
#     （TCP 连得上，但 TLS 握手阶段被断开，表现为 HTTP 000 /
#      "Connection reset by peer"，curl 退出码 56），
#     而 **80 端口（明文 HTTP）是通的**。
#     所以同一个接口要准备 https 和 http 两份地址，探测一次后缓存结果。

_STEAM_BASE = [None]


def steam_api_base(quiet=True):
    """探测 Steam Web API 走 https 还是 http，结果缓存在进程内。

    只探一次 —— 每个接口都探一遍的话，光是等 https 超时就要好几分钟。
    """
    if _STEAM_BASE[0]:
        return _STEAM_BASE[0]
    for base in ("https://api.steampowered.com", "http://api.steampowered.com"):
        try:
            http_get(base + "/ISteamWebAPIUtil/GetServerInfo/v1/",
                     timeout=6, retry=1, quiet=True)
            _STEAM_BASE[0] = base
            if not quiet:
                note = "（443 被拦，回退明文 HTTP —— api_key 会经过链路）" \
                    if base.startswith("http://") else ""
                print("  Steam API 通道: {}{}".format(base, note))
            return base
        except Exception:
            continue
    # 两个都不通：默认 https，让调用方拿到真实的错误
    _STEAM_BASE[0] = "https://api.steampowered.com"
    return _STEAM_BASE[0]


def steam_api_json(path_query, timeout=25, retry=2, quiet=True):
    """调 Steam Web API 并解析 JSON。https 不通自动回退 http。

    path_query 形如 "IPlayerService/GetOwnedGames/v1/?key=...&steamid=..."
    """
    base = steam_api_base(quiet=quiet)
    other = ("http://api.steampowered.com" if base.startswith("https://")
             else "https://api.steampowered.com")
    try:
        return http_json(base + "/" + path_query, timeout=timeout,
                         retry=retry, quiet=quiet)
    except Exception:
        # 缓存的通道失效了（网络波动），换另一个再试一次
        _STEAM_BASE[0] = other
        return http_json(other + "/" + path_query, timeout=timeout,
                         retry=retry, quiet=quiet)


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
