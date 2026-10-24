"""Offline regression checks for data update orchestration and cached data handling."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_data
import build_bili_full as bili
import build_xbox_covers as xbox


class Updates(unittest.TestCase):
    def test_independent_plans(self):
        for target, expected in [('steam', ['build_steam_owned.py']), ('bili', ['fetch_bili_list_cdp.js', 'build_bili_full.py']), ('xbox', ['build_xbox_covers.py'])]:
            self.assertEqual([step[1] for step in update_data.TARGETS[target]], expected)
        self.assertIn('--reuse-detail', update_data.command(update_data.TARGETS['bili'][1]))
        self.assertNotIn('--reuse-detail', update_data.command(update_data.TARGETS['bili-full'][1]))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(update_data.execute('all', plan=True, run=lambda *a, **k: self.fail('plan ran a command')), 0)

    def test_stops_on_failure_instead_of_reusing_stale_bili_list(self):
        calls = []
        def fail(cmd, **kwargs):
            calls.append(cmd)
            return type('Result', (), {'returncode': 1})()
        with patch('update_data.shutil.which', return_value='node'), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                update_data.execute('bili', run=fail)
        self.assertEqual(len(calls), 1)

    def test_output_must_be_written_and_valid(self):
        with tempfile.TemporaryDirectory() as directory, patch('update_data.common.site_root', return_value=directory), contextlib.redirect_stdout(io.StringIO()):
            result = type('Result', (), {'returncode': 0})()
            with self.assertRaises(RuntimeError):
                update_data.execute('steam', run=lambda *a, **k: result)
            def write(*args, **kwargs):
                Path(directory, 'steam_games.json').write_text(json.dumps({'games': [{'appid': 1}]}))
                return result
            self.assertEqual(update_data.execute('steam', run=write), 0)

    def test_xbox_reuses_existing_cover_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets/xbox').mkdir(parents=True)
            (root / 'assets/xbox/game.svg').write_text('<svg/>')
            (root / 'xbox_games.json').write_text(json.dumps({'games': [{'appid': 'game', 'name': 'Game', 'cover': 'assets/xbox/game.svg'}]}))
            with patch('build_xbox_covers.site_root', return_value=directory), patch.object(sys, 'argv', ['build_xbox_covers.py']), patch('build_xbox_covers.search', side_effect=AssertionError('unnecessary network request')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(xbox.main(), 0)
            self.assertEqual(json.loads((root / 'xbox_games.json').read_text())['coverCount'], 1)

    def test_bili_fast_update_preserves_new_play_counts_and_reuses_zero_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'list.json'
            out = root / 'bili_videos.json'
            old = {'videos': [{'bvid': 'BVtest', 'like': 0, 'coin': 0, 'favorite': 0, 'share': 0, 'views': 10}]}
            cache.write_text(json.dumps({'videos': [{'bvid': 'BVtest', 'title': 'New title', 'views': 123, 'reply': 4, 'danmaku': 5}]}))
            profile = {'total_views': 123, 'total_likes': 0, 'total_duration': 0}
            with patch.object(bili, 'LIST_JSON', str(cache)), patch.object(bili, 'OUT', str(out)), patch.object(bili, 'SITE', directory), patch.object(bili, 'load_existing', return_value=old), patch.object(bili, 'load_typeid_map', return_value={}), patch.object(bili, 'warmup'), patch.object(bili, 'grab_cover', return_value='assets/bili/BVtest.jpg'), patch.object(bili, 'fetch_profile', return_value=profile), patch.object(bili, 'get', side_effect=AssertionError('zero metrics should still be reused')), patch.object(sys, 'argv', ['build_bili_full.py', '--reuse-detail']), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bili.main(), 0)
            video = json.loads(out.read_text())['videos'][0]
            self.assertEqual(video['views'], 123)
            self.assertEqual(video['reply'], 4)
            self.assertEqual(video['coin'], 0)


if __name__ == '__main__':
    unittest.main()
