# -*- coding: utf-8 -*-
"""Run independent data updates, stop on errors, and report the actual output files."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import common

HERE = Path(__file__).resolve().parent
TARGETS = {
    'steam': [('python', 'build_steam_owned.py', 'steam_games.json')],
    'steam-family': [('python', 'build_steam_family.py', 'steam_family.json')],
    'steam-all': [('python', 'build_steam_owned.py', 'steam_games.json'), ('python', 'build_steam_family.py', 'steam_family.json')],
    'bili': [('node', 'fetch_bili_list_cdp.js', None), ('python', 'build_bili_full.py', 'bili_videos.json', '--reuse-detail')],
    'bili-full': [('node', 'fetch_bili_list_cdp.js', None), ('python', 'build_bili_full.py', 'bili_videos.json')],
    'xbox': [('python', 'build_xbox_covers.py', 'xbox_games.json')],
    'xbox-full': [('python', 'build_xbox_covers.py', 'xbox_games.json', '--force')],
}
TARGETS['all'] = TARGETS['steam-all'] + TARGETS['bili'] + TARGETS['xbox']


def command(step):
    runtime, script, _output, *args = step
    return ([sys.executable] if runtime == 'python' else [shutil.which('node') or 'node']) + [str(HERE / script)] + args


def execute(target, plan=False, run=subprocess.run):
    root = Path(common.site_root()).resolve()
    print('更新项目: {}\n站点目录: {}'.format(target, root), flush=True)
    if target.startswith('bili') or target == 'all':
        print('B站快速更新复用旧视频的赞/币/收藏，只抓新视频详情；完整更新刷新全部互动数据。', flush=True)
    if target.startswith('xbox') or target == 'all':
        print('Xbox 仅补游戏封面，不会自动同步游戏时长、成就或新增游戏列表。', flush=True)
    for step in TARGETS[target]:
        cmd = command(step)
        if plan:
            print(subprocess.list2cmdline(cmd))
            continue
        if step[0] == 'node' and not shutil.which('node'):
            raise RuntimeError('需要 Node.js 22+ 和 Chrome，当前未找到 node。')
        output = root / step[2] if step[2] else HERE / '.cache' / 'bili_list.json'
        before = output.stat().st_mtime_ns if output.exists() else None
        print('\n执行: {}'.format(step[1]), flush=True)
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
        result = run(cmd, cwd=str(HERE), env=env)
        if result.returncode:
            raise RuntimeError('{} 失败（退出码 {}）；已停止后续步骤。'.format(step[1], result.returncode))
        if not output.exists() or output.stat().st_mtime_ns == before:
            raise RuntimeError('{} 未写入新数据，不能视为更新成功。'.format(output))
        with output.open(encoding='utf-8') as stream:
            data = json.load(stream)
        collection = data.get('videos', data.get('games'))
        if not isinstance(collection, list):
            raise RuntimeError('{} 缺少有效列表。'.format(output))
        print('[已写入] {}（{} 条）'.format(output, len(collection)), flush=True)
    if not plan:
        print('\n更新完成。本地 IIS 请刷新对应页面，或点击“刷新数据”。', flush=True)
        print('线上网站不会自动读取本地文件：请检查修改后提交并推送 JSON 与新增封面到 GitHub，等待 Cloudflare 部署。', flush=True)
        print('如果浏览的 IIS 目录不是上面的“站点目录”，请将 IIS 物理路径指向该目录，或通过 SITE_ROOT 指定。', flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=TARGETS)
    parser.add_argument('--plan', action='store_true', help='仅显示命令，不联网、不写数据')
    args = parser.parse_args()
    try:
        return execute(args.target, args.plan)
    except (OSError, RuntimeError, ValueError) as error:
        print('\n[失败] {}'.format(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
