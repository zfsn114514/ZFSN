"""Cache coherency regressions: both HTML entry points must use current asset bytes."""
import contextlib
import hashlib
import io
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import hash_assets


class AssetVersions(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for folder in ['assets/js','assets/css','admin']: (self.root/folder).mkdir(parents=True)
        (self.root/'assets/js/appearance.js').write_text('theme v1')
        (self.root/'assets/css/nightcity.css').write_text('body{background:url(../branding/seal.svg)}')
        for file,prefix in [('index.html',''),('admin/index.html','../')]:
            (self.root/file).write_text('<script src="'+prefix+'assets/js/appearance.js"></script><link href="'+prefix+'assets/css/nightcity.css">')
        (self.root/'_headers').write_text('# custom header\n')

    def tearDown(self): self.temp.cleanup()

    def run_hash(self,*args):
        with patch.object(hash_assets.common,'site_root',return_value=str(self.root)),patch.object(hash_assets,'ASSETS',['assets/js/appearance.js','assets/css/nightcity.css']),patch.object(sys,'argv',['hash_assets.py',*args]),contextlib.redirect_stdout(io.StringIO()):
            return hash_assets.main()

    def test_versions_both_entries_and_preserves_unmanaged_files(self):
        other=self.root/'assets/js/foreign.aaaaaaaa.js';other.write_text('unmanaged')
        self.assertEqual(self.run_hash(),0)
        old=hashlib.sha256(b'theme v1').hexdigest()[:8]
        self.assertIn('appearance.'+old+'.js',(self.root/'index.html').read_text())
        self.assertIn('../assets/js/appearance.'+old+'.js',(self.root/'admin/index.html').read_text())
        self.assertEqual(self.run_hash('--check'),0)
        (self.root/'assets/js/appearance.js').write_text('theme v2')
        self.assertEqual(self.run_hash('--check'),1)
        self.assertEqual(self.run_hash(),0)
        self.assertFalse((self.root/('assets/js/appearance.'+old+'.js')).exists())
        self.assertTrue(other.exists())

    def test_check_rejects_stale_html_and_corrupted_asset(self):
        self.run_hash()
        file=self.root/'admin/index.html'
        file.write_text(re.sub(r'appearance\.[a-f0-9]{8}\.js','appearance.js',file.read_text()))
        self.assertEqual(self.run_hash('--check'),1)
        self.run_hash()
        next((self.root/'assets/js').glob('appearance.*.js')).write_text('corrupted')
        self.assertEqual(self.run_hash('--check'),1)

    def test_repository_entrypoints_have_no_unversioned_first_party_assets(self):
        repo=Path(__file__).resolve().parents[2]
        for name in ['index.html','admin/index.html']:
            references=re.findall(r'(?:src|href)=["\']((?:\.\./)?assets/(?:js|css)/[^"\']+)["\']',(repo/name).read_text())
            self.assertTrue(references)
            for reference in references:
                self.assertRegex(reference,r'\.[a-f0-9]{8}\.(?:css|js)$',reference)

if __name__=='__main__':unittest.main()
