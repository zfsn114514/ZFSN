"""Read-only diagnosis distinguishes checkout, IIS and resource mismatches."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import check_local_site

class LocalCheck(unittest.TestCase):
    def test_normalized_fingerprint(self):
        self.assertEqual(check_local_site.fingerprint(b'a\r\nb'),check_local_site.fingerprint(b'a\nb'))

    def test_matching_assets_and_stale_iis_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);folder=root/'assets/css';folder.mkdir(parents=True)
            css=b'body{color:red}';name='assets/css/app.'+hashlib.sha256(css).hexdigest()[:8]+'.css'
            (root/name).write_bytes(css);html=('<link href="'+name+'">').encode();(root/'index.html').write_bytes(html)
            def served(url): return html if url==check_local_site.BASE else css
            with patch.object(check_local_site,'ROOT',root),patch.object(check_local_site,'fetch',side_effect=served),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(check_local_site.main(),0)
            def stale(url): return html if url==check_local_site.BASE else b'old CSS'
            with patch.object(check_local_site,'ROOT',root),patch.object(check_local_site,'fetch',side_effect=stale),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(check_local_site.main(),1)
            self.assertEqual((root/name).read_bytes(),css)

if __name__=='__main__':unittest.main()
