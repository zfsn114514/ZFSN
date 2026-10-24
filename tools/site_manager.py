# -*- coding: utf-8 -*-
"""One local entry point for Git updates, platform data and explicit publication."""
from pathlib import Path
import datetime
import os
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
DATA_PATHS = ['bili_videos.json', 'steam_games.json', 'steam_family.json', 'xbox_games.json', 'assets/bili', 'assets/steam', 'assets/xbox']


class Manager:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        folder = self.root / '.site-manager' / 'logs'
        folder.mkdir(parents=True, exist_ok=True)
        self.log = folder / (datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.log')

    def run(self, args, capture=False):
        if capture:
            return subprocess.check_output(args, cwd=self.root, text=True, encoding='utf-8', errors='replace').strip()
        with self.log.open('a', encoding='utf-8') as log:
            command = subprocess.list2cmdline(args)
            print('\n> ' + command, flush=True)
            log.write('\n> ' + command + '\n')
            with subprocess.Popen(args, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, encoding='utf-8', errors='replace', env={**os.environ, 'SITE_ROOT': str(self.root), 'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1'}) as proc:
                for line in proc.stdout:
                    print(line, end='', flush=True)
                    log.write(line)
                if proc.wait():
                    raise RuntimeError('命令失败，已停止。本地文件不会被强制覆盖。日志：' + str(self.log))

    def git(self, *args, **kwargs):
        return self.run(['git', *args], **kwargs)

    def guard(self):
        if self.git('branch', '--show-current', capture=True) != 'main':
            raise RuntimeError('请先切换到 main；本工具不会自动切换或重置分支。')
        if self.git('diff', '--name-only', '--diff-filter=U', capture=True):
            raise RuntimeError('存在合并冲突，请先解决；冲突内容已保留。')
        merge_path = self.git('rev-parse', '--git-path', 'MERGE_HEAD', capture=True)
        if (self.root / merge_path).exists():
            raise RuntimeError('上一次合并尚未完成。请先处理合并状态。')

    def pull(self):
        self.guard()
        self.git('fetch', 'origin')
        self.git('-c', 'core.editor=true', 'merge', '--autostash', '--no-edit', 'origin/main')
        self.guard()
        print('\n已更新本地网站；保留本地提交和修改，没有推送。IIS 页面请按 Ctrl+F5。')

    def save_data(self):
        self.guard()
        # Ask Git for exact changed paths; never stage configs, backups or unrelated files.
        raw = subprocess.check_output(['git', 'diff', '--name-only', '-z', 'HEAD', '--', *DATA_PATHS], cwd=self.root)
        raw += subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', *DATA_PATHS], cwd=self.root)
        paths = sorted(set(raw.decode('utf-8').strip('\0').split('\0')) - {''})
        if not paths:
            print('没有需要保存的新数据；这不是错误。')
            return
        print('仅保存以下数据与封面：\n' + '\n'.join(paths))
        pathfile = self.root / '.site-manager' / 'data-paths.txt'
        pathfile.write_bytes(('\0'.join(paths) + '\0').encode('utf-8'))
        self.git('add', '--pathspec-from-file=' + str(pathfile), '--pathspec-file-nul')
        self.git('commit', '--only', '-m', 'Update site platform data', '--pathspec-from-file=' + str(pathfile), '--pathspec-file-nul')
        print('数据已保存为本地提交，尚未发布线上。')

    def publish(self, confirm=input):
        self.guard()
        self.git('fetch', 'origin')
        print('\n即将发布的本地提交（可能包括你之前的本地代码提交）：')
        self.git('--no-pager', 'log', '--oneline', 'origin/main..HEAD')
        self.git('status', '--short', '--branch')
        if self.git('status', '--porcelain', capture=True):
            raise RuntimeError('还有未保存文件。先选择“保存数据”或自行提交代码，再发布。')
        if confirm('发布会推送 main 并触发现有网站部署。输入 PUBLISH 确认，其它输入取消：').strip() != 'PUBLISH':
            print('已取消发布。')
            return
        self.git('-c', 'core.editor=true', 'merge', '--no-edit', 'origin/main')
        self.guard()
        self.git('push', 'origin', 'HEAD:main')
        print('GitHub 已接收提交。请等待网站部署完成，再刷新线上网页。')

    def update(self, target):
        self.run([sys.executable, str(self.root / 'tools' / 'update_data.py'), target])


def main():
    manager = Manager()
    targets = {'2': 'bili', '3': 'bili-full', '4': 'steam', '5': 'steam-family', '6': 'xbox', '7': 'all'}
    print('日志：' + str(manager.log))
    while True:
        print('''
╔══════════ ZFSN 站点管理 ══════════╗
  1  从 GitHub 更新本地网站
  2  单独更新 B站（快速）
  3  单独更新 B站（完整互动数据）
  4  单独更新 Steam 自有游戏
  5  单独更新 Steam 家庭共享
  6  单独更新 Xbox 缺失封面
  7  更新全部平台
  8  保存平台数据与封面（本地提交）
  9  发布已保存提交到 GitHub main
  S  查看 Git 状态与本地提交
  D  检查本地文件与 IIS 返回内容是否一致
  L  打开本地 IIS 网站
  0  退出
╚═════════════════════════════════╝
  采集、保存、发布是独立步骤；不会自动发布。
  Xbox 更新仅补封面，不会自动获取游戏列表或时长。''')
        try:
            choice = input('请选择：').strip().upper()
            if choice == '0': return 0
            if choice == '1': manager.pull()
            elif choice in targets: manager.update(targets[choice])
            elif choice == '8': manager.save_data()
            elif choice == '9': manager.publish()
            elif choice == 'S':
                manager.git('status', '--short', '--branch')
                manager.git('--no-pager', 'log', '--oneline', '-8')
            elif choice == 'D': manager.run([sys.executable, str(manager.root / 'tools' / 'check_local_site.py')])
            elif choice == 'L': webbrowser.open('http://localhost:88/')
            else: print('请选择菜单中已有的选项。')
        except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
            print('\n[未完成] ' + str(error))
            print('日志：' + str(manager.log))
        except (EOFError, KeyboardInterrupt): return 0


if __name__ == '__main__':
    sys.exit(main())
