"""Extract the selected original Java 1.21.1 textures from the official client.

Run with an optional path to a local 1.21.1 client jar. Otherwise download the
official SHA-1 verified archive into the OS temporary directory, not the site.
"""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1] / 'minecraft'
BLOCKS = ('grass_block_side grass_block_side_overlay dirt stone cobblestone bedrock '
          'oak_log oak_planks oak_leaves sand coal_ore iron_ore diamond_ore '
          'crafting_table_front furnace_front furnace_front_on glass torch water_still water_flow white_wool stone_bricks sandstone iron_block diamond_block coal_block smooth_stone').split()
ITEMS = ('stick coal raw_iron iron_ingot diamond apple porkchop cooked_porkchop '
         'wooden_pickaxe stone_pickaxe iron_pickaxe diamond_pickaxe '
         'wooden_axe stone_axe iron_axe wooden_sword stone_sword iron_sword '
         'wooden_shovel stone_shovel iron_shovel beef cooked_beef chicken cooked_chicken mutton cooked_mutton feather leather bucket water_bucket egg charcoal diamond_axe diamond_sword diamond_shovel').split()


def main():
    source = json.loads((ROOT / 'asset-source.json').read_text(encoding='utf-8'))
    archive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / 'zfsn-minecraft-1.21.1.jar'
    if not archive.exists():
        urllib.request.urlretrieve(source['client'], archive)
    if hashlib.sha1(archive.read_bytes()).hexdigest() != source['sha1']:
        raise ValueError('Client checksum mismatch: expected the unmodified Java 1.21.1 client.')
    files = {name: f'block/{name}.png' for name in BLOCKS}
    files.update({name: f'item/{name}.png' for name in ITEMS})
    files.update({'steve': 'entity/player/wide/steve.png', 'zombie': 'entity/zombie/zombie.png', 'pig': 'entity/pig/pig.png'})
    files.update({'cow':'entity/cow/cow.png','sheep':'entity/sheep/sheep.png','sheep_fur':'entity/sheep/sheep_fur.png','chicken_mob':'entity/chicken.png'})
    files.update({
        'gui_button':'gui/sprites/widget/button.png',
        'gui_button_hover':'gui/sprites/widget/button_highlighted.png',
        'gui_button_disabled':'gui/sprites/widget/button_disabled.png',
        'gui_hotbar':'gui/sprites/hud/hotbar.png',
        'gui_hotbar_selection':'gui/sprites/hud/hotbar_selection.png',
        'gui_inventory':'gui/container/inventory.png',
        'gui_crafting':'gui/container/crafting_table.png',
        'gui_furnace':'gui/container/furnace.png',
        'gui_logo':'gui/title/minecraft.png',
        'gui_edition':'gui/title/edition.png',
        'gui_panorama':'gui/title/background/panorama_0.png',
    })
    files.update({f'heart_{n}': f'gui/sprites/hud/heart/{n}.png' for n in ['container', 'full', 'half']})
    files.update({f'food_{n}': f'gui/sprites/hud/food_{n}.png' for n in ['empty', 'full', 'half']})
    files.update({f'destroy_stage_{i}': f'block/destroy_stage_{i}.png' for i in range(10)})
    (ROOT / 'textures').mkdir(exist_ok=True, parents=True)
    with zipfile.ZipFile(archive) as jar:
        hashes = {}
        for name, entry in files.items():
            data = jar.read('assets/minecraft/textures/' + entry)
            (ROOT / 'textures' / (name + '.png')).write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
    (ROOT / 'textures' / 'manifest.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    print(f'Extracted {len(files)} unchanged original textures.')


if __name__ == '__main__':
    main()
