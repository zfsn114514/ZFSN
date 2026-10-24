from pathlib import Path
import hashlib
import json
import struct

here = Path(__file__).resolve().parent
site = here.parents[1]
manifest = json.loads((here / 'Assets/source-manifest.json').read_text())
for name, hotspot in [('arrow', (4, 2)), ('point', (12, 12))]:
    entry = manifest[name]
    assert hashlib.sha256((site / entry['source']).read_bytes().replace(b'\r\n', b'\n')).hexdigest() == entry['sha256'], 'site SVG changed; re-rasterize ' + name
    raw = (here / 'Assets' / (name + '.cur')).read_bytes()
    reserved, kind, count = struct.unpack_from('<HHH', raw)
    assert (reserved, kind, count) == (0, 2, 1)
    width, height, colors, zero, x, y, length, offset = struct.unpack_from('<BBBBHHII', raw, 6)
    assert (width, height, x, y) == (32, 32, *hotspot)
    assert len(raw) == offset + length
    header, dib_width, dib_height, planes, bits = struct.unpack_from('<IiiHH', raw, offset)
    assert (header, dib_width, dib_height, planes, bits) == (40, 32, 64, 1, 32)
    pixels = raw[offset + 40:offset + 40 + 32 * 32 * 4]
    assert max(pixels[3::4]) > 100
    assert sum(a > 0 for a in pixels[3::4]) > 50
    assert (here / 'Assets' / (name + '.png')).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    print('PASS exact source hash, CUR structure, alpha and hotspot:', name)
