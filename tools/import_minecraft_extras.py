"""Import the extra 1.21.1 textures the gameplay features need (not in the
catalogue importer): bow-pulling frames, humanoid armour layer sheets and the
in-flight arrow sprite. These live outside manifest.json on purpose —
manifest.json drives the eager preload list for world textures only.
"""
import hashlib
import json
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'minecraft'

# name -> jar path (relative to assets/minecraft/textures/)
FILES = {
    'bow_pulling_0': 'item/bow_pulling_0.png',
    'bow_pulling_1': 'item/bow_pulling_1.png',
    'bow_pulling_2': 'item/bow_pulling_2.png',
    'arrow_projectile': 'entity/projectiles/arrow.png',
    'spectral_arrow_projectile': 'entity/projectiles/spectral_arrow.png',
    'tipped_arrow_projectile': 'entity/projectiles/tipped_arrow.png',
    # humanoid armour: layer_1 covers helmet+chestplate+boots, layer_2 leggings
    **{f'armor/{m}_{n}': f'models/armor/{m}_layer_{n}.png'
       for m in ('iron', 'chainmail', 'gold', 'diamond', 'netherite')
       for n in (1, 2)},
    'armor/leather_1': 'models/armor/leather_layer_1.png',
    'armor/leather_1_overlay': 'models/armor/leather_layer_1_overlay.png',
    'armor/leather_2': 'models/armor/leather_layer_2.png',
    'armor/leather_2_overlay': 'models/armor/leather_layer_2_overlay.png',
    'armor/turtle_1': 'models/armor/turtle_layer_1.png',
}


def main():
    archive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / 'zfsn-minecraft-1.21.1.jar'
    (ROOT / 'textures' / 'armor').mkdir(exist_ok=True, parents=True)
    hashes = {}
    with zipfile.ZipFile(archive) as jar:
        for name, entry in FILES.items():
            data = jar.read('assets/minecraft/textures/' + entry)
            (ROOT / 'textures' / (name + '.png')).write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
    print(f'Extracted {len(FILES)} extra textures (armor/, bow_pulling_*, arrow_projectile).')
    print('armor sheets:', ', '.join(sorted(k for k in hashes if k.startswith('armor/'))))


if __name__ == '__main__':
    main()
