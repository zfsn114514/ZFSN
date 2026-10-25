"""Download selected SHA-1 verified original sound assets, never the whole library."""
import hashlib
import json
from pathlib import Path
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT=Path(__file__).resolve().parents[1]/'minecraft'
GROUPS={
    'click':['random/click'], 'hurt':['damage/hit1','damage/hit2','damage/hit3'],
    'eat':['random/eat1','random/eat2'], 'pickup':['random/pop'], 'break_tool':['random/break'],
    'splash':['liquid/splash'], 'water':['liquid/water'],
    **{f'dig_{m}':[f'dig/{m}{i}' for i in [1,2,3]] for m in ['stone','wood','grass','gravel','sand','glass']},
    **{f'step_{m}':[f'step/{m}{i}' for i in [1,2]] for m in ['stone','wood','grass','gravel','sand']},
    **{m:[f'mob/{m}/say{i}' for i in [1,2]] for m in ['pig','cow','sheep','chicken','zombie']},
}
GROUPS['dig_glass']=['random/glass1','random/glass2','random/glass3']

def main():
    source=json.loads((ROOT/'asset-source.json').read_text())
    meta=json.load(urllib.request.urlopen(source['metadata']))
    asset_index=json.load(urllib.request.urlopen(meta['assetIndex']['url']))['objects']
    target=ROOT/'sounds';target.mkdir(exist_ok=True)
    manifest={}
    jobs=[]
    for group,names in GROUPS.items():
        manifest[group]=[]
        for name in names:
            key=f'minecraft/sounds/{name}.ogg'
            if key not in asset_index:continue
            digest=asset_index[key]['hash'];filename=name.replace('/','_')+'.ogg'
            jobs.append((filename,digest));manifest[group].append(filename)
        if not manifest[group]:raise ValueError(f'No sound assets for {group}')
    def download(job):
        filename,digest=job;path=target/filename
        data=path.read_bytes() if path.exists() else urllib.request.urlopen(f'https://resources.download.minecraft.net/{digest[:2]}/{digest}').read()
        if hashlib.sha1(data).hexdigest()!=digest:raise ValueError(f'Invalid asset {filename}')
        path.write_bytes(data)
    with ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(download,jobs))
    (target/'manifest.json').write_text(json.dumps(manifest,indent=2))
    (target/'sources.json').write_text(json.dumps({'assetIndex':meta['assetIndex'],'sha1':dict(jobs)},indent=2))
    print(f'Imported {len(jobs)} official OGG sounds in {len(manifest)} event groups')

if __name__=='__main__':main()
