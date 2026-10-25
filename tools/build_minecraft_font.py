"""Make a small webfont from the client's actual bitmap glyphs (ASCII + used CJK).
Requires Pillow, fonttools and brotli. Original glyph shapes are preserved.
"""
from pathlib import Path
import tempfile,zipfile,json,urllib.request,io,re
from PIL import Image
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
ROOT=Path(__file__).resolve().parents[1]/'minecraft'
source=json.loads((ROOT/'asset-source.json').read_text())
meta=json.load(urllib.request.urlopen(source['metadata']))
index=json.load(urllib.request.urlopen(meta['assetIndex']['url']))['objects']
h=index['minecraft/font/unifont.zip']['hash']
raw=urllib.request.urlopen(f'https://resources.download.minecraft.net/{h[:2]}/{h}').read()
glyphs={}
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    for filename in z.namelist():
        if filename.endswith('.hex'):
            for line in z.read(filename).decode().splitlines():
                if ':' in line:
                    key,bits=line.split(':',1);glyphs[int(key,16)]=(bytes.fromhex(bits),len(bits)//4)
with zipfile.ZipFile(Path(tempfile.gettempdir())/'zfsn-minecraft-1.21.1.jar') as z:
    providers=json.loads(z.read('assets/minecraft/font/include/default.json'))['providers']
    for p in providers:
        if p.get('type')!='bitmap' or 'ascii' not in p.get('file',''):continue
        im=Image.open(io.BytesIO(z.read('assets/minecraft/textures/'+p['file'].split(':')[1]))).convert('RGBA')
        for row,chars in enumerate(p['chars']):
            for col,c in enumerate(chars):
                if c=='\x00':continue
                pixels=[[im.getpixel((col*8+x,row*8+y))[3]>0 for x in range(8)] for y in range(8)]
                glyphs[ord(c)]=(pixels,8)
chars=set(range(32,127))
for file in [ROOT/'index.html',ROOT/'game.js']:
    chars.update(ord(c) for c in file.read_text(encoding='utf-8') if ord(c)>=127)
font=FontBuilder(1024,isTTF=True);names=['.notdef']+[f'u{c:04X}' for c in sorted(chars) if c in glyphs]
font.setupGlyphOrder(names);out={};metrics={};cmap={}
for name in names:
    pen=TTGlyphPen(None);advance=512
    if name!='.notdef':
        code=int(name[1:],16);data,width=glyphs[code];pixels=data if isinstance(data,list) else [[bool(data[y*(width//8)+x//8]&(128>>(x%8))) for x in range(width)] for y in range(16)]
        unit=1024/len(pixels);right=0
        for y,row in enumerate(pixels):
            for x,on in enumerate(row):
                if not on:continue
                right=max(right,x+1);x0=int(x*unit);y0=int(896-(y+1)*unit);u=int(unit)
                pen.moveTo((x0,y0));pen.lineTo((x0,y0+u));pen.lineTo((x0+u,y0+u));pen.lineTo((x0+u,y0));pen.closePath()
        advance=int((right+1)*unit) if right else 512;cmap[code]=name
    out[name]=pen.glyph();metrics[name]=(advance,0)
font.setupCharacterMap(cmap);font.setupGlyf(out);font.setupHorizontalMetrics(metrics);font.setupHorizontalHeader(ascent=896,descent=-128)
font.setupNameTable({'familyName':'Minecraft Bitmap Subset','styleName':'Regular','uniqueFontIdentifier':'MinecraftBitmapSubset','fullName':'Minecraft Bitmap Subset','psName':'MinecraftBitmapSubset'})
font.setupOS2(sTypoAscender=896,sTypoDescender=-128,usWinAscent=1024,usWinDescent=128);font.setupPost();font.setupMaxp()
font.font.flavor='woff2';font.save(ROOT/'mc-font.woff2');print('Built',len(cmap),'original bitmap glyphs')
