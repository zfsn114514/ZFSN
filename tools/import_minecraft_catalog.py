"""Import Java 1.21.1 item catalogue and original creative container assets.
Cube blocks are placeable; other catalogue entries remain collectable until their mechanics exist.
"""
import json,zipfile,tempfile,urllib.request,hashlib,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'minecraft'
z=zipfile.ZipFile(Path(tempfile.gettempdir())/'zfsn-minecraft-1.21.1.jar')
files=set(z.namelist());lang=json.loads(z.read('assets/minecraft/lang/en_us.json'))
index=json.loads((root.parent/'.tmp-mc/reference/asset-index.json').read_text())
index=index.get('objects',index)
h=index['minecraft/lang/zh_cn.json']['hash']
lang.update(json.loads(urllib.request.urlopen('https://resources.download.minecraft.net/'+h[:2]+'/'+h).read()))
def model(name,seen=None):
    seen=set() if seen is None else seen
    name=name.replace('minecraft:','')
    if name in seen:return {},[]
    seen.add(name);path='assets/minecraft/models/'+name+'.json'
    if path not in files:return {},[name]
    m=json.loads(z.read(path));tex,parents=model(m['parent'],seen) if 'parent'in m else ({},[])
    tex.update(m.get('textures',{}));return tex,[name]+parents
from PIL import Image,ImageDraw,ImageEnhance
(root/'icons').mkdir(exist_ok=True)
def cube_icon(id,tex):
    def texture(keys):
        v=next((tex[k]for k in keys if k in tex),None)
        for _ in range(10):
            if v and v.startswith('#'):v=tex.get(v[1:])
        if not v:return None
        import io
        try:return Image.open(io.BytesIO(z.read('assets/minecraft/textures/'+v.replace('minecraft:','')+'.png'))).convert('RGBA').crop((0,0,16,16))
        except KeyError:return None
    out=Image.new('RGBA',(32,32))
    # ★ 面 key 不止 top/side/front：原版 block/cube 用的是 up/down/north/south/east/west，
    #   工作台/制图台/制箭台/锻造台就是这一族，带釉陶瓦更是只有 pattern（顶面图案）。
    #   key 列表不全时 texture() 返回 None → 三个面全被跳过 → 存下一张 32×32 全透明图
    #   （83 字节），创造栏里就是一块空白格子，而图标「加载成功」，前端兜不住。
    for keys,quad,shade in [
        (['top','up','end','all','pattern'],[(16,1),(30,8),(16,15),(2,8)],1),
        (['side','south','front','all','down','pattern'],[(2,8),(16,15),(16,31),(2,24)],.72),
        (['front','north','side','all','east','pattern'],[(16,15),(30,8),(30,24),(16,31)],.88)]:
        im=texture(keys)
        if im is None:continue
        im=ImageEnhance.Brightness(im).enhance(shade)
        p0,p1,_,p3=quad;a=(p1[0]-p0[0])/16;b=(p3[0]-p0[0])/16;c=(p1[1]-p0[1])/16;d=(p3[1]-p0[1])/16;det=a*d-b*c
        coeff=(d/det,-b/det,(-d*p0[0]+b*p0[1])/det,-c/det,a/det,(c*p0[0]-a*p0[1])/det)
        layer=im.transform((32,32),Image.Transform.AFFINE,coeff,Image.Resampling.NEAREST)
        mask=Image.new('L',(32,32));ImageDraw.Draw(mask).polygon(quad,fill=255)
        layer.putalpha(Image.composite(layer.getchannel('A'),Image.new('L',(32,32)),mask));out.alpha_composite(layer)
    # 兜底：真的一面都没画出来时，宁可放源贴图也不要存空图。
    if out.getbbox() is None:
        src=texture(['all','side','top','up','front','north','end','pattern','particle'])
        if src is None:return
        out=src.resize((32,32),Image.Resampling.NEAREST)
    out.save(root/'icons'/f'{id}.png')
catalog=[]
for filename in sorted(files):
    if not filename.startswith('assets/minecraft/models/item/') or not filename.endswith('.json'):continue
    id=filename.rsplit('/',1)[1][:-5]
    key=next((k for k in ['item.minecraft.'+id,'block.minecraft.'+id] if k in lang),None)
    if not key:continue
    tex,parents=model('item/'+id)
    value=next((tex[k] for k in ['layer0','all','side','front','top','particle','texture'] if k in tex),None)
    for _ in range(10):
        if value and value.startswith('#'):value=tex.get(value[1:])
    if not value:continue
    path='assets/minecraft/textures/'+value.replace('minecraft:','')+'.png'
    if path not in files:continue
    cube=any(p in ['block/cube_all','block/cube_column','block/cube_bottom_top','block/cube','block/orientable','block/orientable_with_bottom','block/cube_column_horizontal','block/leaves'] for p in parents)
    # Never imply functioning doors, redstone or machines merely from their cube model.
    cube=cube and not any(w in id for w in ['command','spawner','portal','structure','jigsaw'])
    category='building' if cube else 'ingredients'
    if any(w in id for w in ['sword','axe','shovel','hoe','bow','helmet','chestplate','leggings','boots','shield','trident']):category='equipment'
    elif any(w in id for w in ['apple','bread','beef','pork','chicken','mutton','carrot','potato','cookie','stew','soup','melon_slice','berries','cod','salmon','rabbit','honey_bottle']):category='food'
    elif any(w in id for w in ['dye','wool','concrete','terracotta','stained']):category='colored'
    elif any(w in id for w in ['sapling','flower','leaves','log','dirt','sand','stone','ore','seed','moss','grass']):category='nature'
    elif any(w in id for w in ['redstone','piston','repeater','comparator','lever','button','rail']):category='redstone'
    elif any(w in id for w in ['spawn_egg']):category='spawn'
    (root/'textures'/f'{id}.png').write_bytes(z.read(path))
    if cube:cube_icon(id,tex)
    catalog.append(dict(id=id,name=lang[key],cube=cube,category=category))
(root/'catalog.js').write_text('export const CATALOG = '+json.dumps(catalog,ensure_ascii=False,separators=(',',':'))+';\n',encoding='utf-8')
for name in ['tab_items','tab_item_search','tab_inventory']:
    (root/'textures'/f'creative_{name}.png').write_bytes(z.read('assets/minecraft/textures/gui/container/creative_inventory/'+name+'.png'))
for name in ['tab_top_selected_1','tab_top_unselected_1','tab_bottom_selected_1','tab_bottom_unselected_1','scroller']:
    (root/'textures'/f'creative_{name}.png').write_bytes(z.read('assets/minecraft/textures/gui/sprites/container/creative_inventory/'+name+'.png'))
print('Catalogue',len(catalog),'cube blocks',sum(x['cube'] for x in catalog))
