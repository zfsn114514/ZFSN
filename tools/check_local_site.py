# -*- coding: utf-8 -*-
"""Read-only IIS diagnostics: compare served HTML and assets with this checkout."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import re
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://localhost:88/'


def fingerprint(data):
    # CRLF/LF conversions by Git on Windows do not change executable content.
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()[:8]


def fetch(url):
    separator = '&' if '?' in url else '?'
    request = urllib.request.Request(url + separator + 'zfsn-check=' + str(time.time_ns()),
                                    headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.read()


def main():
    print('ZFSN 本地网站自检（只读，不改动代码和 Git）')
    print('文件目录：' + str(ROOT))
    print('IIS 地址：' + BASE)
    for name, args in [('当前提交', ['rev-parse', '--short', 'HEAD']), ('已获取的 GitHub 提交', ['rev-parse', '--short', 'origin/main'])]:
        try:
            value = subprocess.check_output(['git', *args], cwd=ROOT, stderr=subprocess.DEVNULL, text=True).strip()
            print(name + '：' + value)
        except (OSError, subprocess.CalledProcessError):
            print(name + '：无法读取')
    local = (ROOT / 'index.html').read_bytes()
    references = re.findall(r'(?:href|src)=["\'](assets/(?:css|js)/[^"\']+)["\']', local.decode('utf-8-sig'))
    problems = 0
    try:
        served = fetch(BASE)
        if fingerprint(served) == fingerprint(local):
            print('[正常] IIS 首页与此目录的 index.html 一致。')
        else:
            problems += 1
            print('[不一致] IIS 首页与此目录文件不同。请检查 IIS 物理路径、默认文档或服务器缓存。')
            print('本地指纹：' + fingerprint(local) + ' / IIS 指纹：' + fingerprint(served))
    except (OSError, ValueError) as error:
        print('[失败] 无法访问本地 IIS：' + str(error))
        return 1

    def check(reference):
        file = ROOT / urllib.parse.urlsplit(reference).path
        if not file.is_file():
            return '[缺少文件] ' + reference
        expected = fingerprint(file.read_bytes())
        version = re.search(r'\.([a-f0-9]{8})\.(?:js|css)$', reference)
        if version and expected != version.group(1):
            return '[文件被修改] ' + reference + '，内容与版本号不符。'
        try:
            actual = fingerprint(fetch(urllib.parse.urljoin(BASE, reference)))
            if actual != expected:
                return '[IIS 内容不同] ' + reference
        except (OSError, ValueError) as error:
            return '[资源加载失败] ' + reference + '：' + str(error)
        return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(check, references):
            if result:
                problems += 1
                print(result)
    if problems:
        print('\n发现 {} 项问题。请截图本窗口的完整结果。'.format(problems))
        return 1
    print('[正常] {} 个脚本与样式文件均存在，IIS 返回内容一致。'.format(len(references)))
    print('若浏览器仍显示异常，请按 Ctrl+F5，并从“切换风格”选择所需主题。')
    print('localhost 与线上域名分别保存个人风格选择。')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except OSError as error:
        print('[失败] ' + str(error))
        raise SystemExit(1)
