"""Exercise maintenance operations in disposable local Git repositories."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from site_manager import Manager


class Maintenance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.root / 'bili_videos.json').write_text('old')
        (self.root / 'index.html').write_text('old')
        (self.root / '.gitignore').write_text('.site-manager/\n')
        self.git('add', '.')
        self.git('commit', '-m', 'base')
        self.manager = Manager(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.STDOUT, text=True).strip()

    def test_save_only_data_preserves_other_staged_files_and_noop(self):
        (self.root / 'bili_videos.json').write_text('new')
        self.git('add', 'bili_videos.json')
        (self.root / 'index.html').write_text('user edit')
        self.git('add', 'index.html')
        (self.root / 'tools').mkdir()
        (self.root / 'tools/config.json').write_text('private config')
        with contextlib.redirect_stdout(io.StringIO()): self.manager.save_data()
        self.assertEqual(self.git('show', 'HEAD:bili_videos.json'), 'new')
        self.assertEqual(self.git('show', 'HEAD:index.html'), 'old')
        self.assertIn('M  index.html', self.git('status', '--porcelain'))
        old = self.git('rev-parse', 'HEAD')
        with contextlib.redirect_stdout(io.StringIO()): self.manager.save_data()
        self.assertEqual(self.git('rev-parse', 'HEAD'), old)

    def test_pull_preserves_uncommitted_edits_and_local_commits(self):
        remote = self.root / 'remote.git'
        self.git('clone', '--bare', '.', str(remote))
        self.git('remote', 'add', 'origin', str(remote))
        self.git('checkout', '-b', 'upstream')
        (self.root / 'remote.txt').write_text('remote')
        self.git('add', 'remote.txt'); self.git('commit', '-m', 'remote change')
        self.git('push', 'origin', 'HEAD:main'); self.git('checkout', 'main')
        (self.root / 'local.txt').write_text('local')
        self.git('add', 'local.txt'); self.git('commit', '-m', 'local change')
        (self.root / 'index.html').write_text('uncommitted')
        with contextlib.redirect_stdout(io.StringIO()): self.manager.pull()
        self.assertEqual((self.root / 'index.html').read_text(), 'uncommitted')
        self.assertTrue((self.root / 'local.txt').exists())
        self.assertTrue((self.root / 'remote.txt').exists())

    def test_wrong_branch_is_rejected(self):
        self.git('checkout', '-b', 'other')
        with self.assertRaises(RuntimeError): self.manager.guard()

if __name__ == '__main__': unittest.main()
