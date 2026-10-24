"""Package browser-rasterized, unmodified site cursor PNGs into Windows CUR files.

Assets/arrow.png and point.png are rasterizations of the actual site SVGs at 32px.
Re-rasterize with a browser when the site SVG changes (CairoSVG does not render
SVG Gaussian blur identically). This script only encodes bitmap containers.
"""
from pathlib import Path
import hashlib
import json
import struct
from PIL import Image

HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1]

def cursor_bytes(image, hotspot):
    image = image.convert('RGBA')
    width, height = image.size
    xor = b''.join(bytes((b, g, r, a)) for y in range(height - 1, -1, -1) for x in range(width) for r, g, b, a in [image.getpixel((x, y))])
    mask = bytearray()
    for y in range(height - 1, -1, -1):
        bits = [int(image.getpixel((x, y))[3] == 0) for x in range(width)]
        bits += [0] * ((((width + 31) // 32) * 32) - width)
        for index in range(0, len(bits), 8):
            value = 0
            for bit in bits[index:index + 8]: value = (value << 1) | bit
            mask.append(value)
    dib = struct.pack('<IiiHHIIiiII', 40, width, height * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0) + xor + mask
    return struct.pack('<HHHBBBBHHII', 0, 2, 1, width, height, 0, 0, *hotspot, len(dib), 22) + dib


def main():
    manifest = {}
    for name, hotspot in [('arrow', (4, 2)), ('point', (12, 12))]:
        source = SITE / 'assets/cursor' / (name + '.svg')
        image = Image.open(HERE / 'Assets' / (name + '.png'))
        assert image.size == (32, 32)
        data = cursor_bytes(image, hotspot)
        (HERE / 'Assets' / (name + '.cur')).write_bytes(data)
        manifest[name] = {'source': str(source.relative_to(SITE)), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'hotspot': list(hotspot), 'size': [32, 32]}
    Image.open(HERE / 'Assets/arrow.png').save(HERE / 'Assets/app.ico', format='ICO', sizes=[(32, 32)])
    (HERE / 'Assets/source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('CUR assets generated from site rasterizations; hotspots 4,2 and 12,12.')

if __name__ == '__main__': main()
