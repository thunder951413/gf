import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit
import requests

ROOT = Path('/Users/surfing/tools/life/output/zzz_short_skirt')
REFS = ROOT / 'references'
REFS.mkdir(parents=True, exist_ok=True)
FACE = '/var/folders/1d/wnwk03995qn1wrnwjwg_bdjw0000gn/T/codex-clipboard-2ad013a6-5f1f-48ec-906b-74d02e8bcb12.png'
API = 'https://zenless-zone-zero.fandom.com/api.php'
session = requests.Session()
def category(name):
    result = session.get(API, params={'action':'query','list':'categorymembers','cmtitle':'Category:'+name,'cmlimit':'max','format':'json'}, timeout=30).json()
    return {x['title'] for x in result['query']['categorymembers'] if x['ns'] == 0}
names = sorted(category('Female_Agents') & category('Playable_Agents'))
assert len(names) == 46, names
pages = session.get(API, params={'action':'query','titles':'|'.join(names),'prop':'pageimages','format':'json','pithumbsize':1200}, timeout=30).json()['query']['pages']
urls = {p['title']:p.get('thumbnail',{}).get('source') for p in pages.values()}
assert all(urls.values()), [n for n,u in urls.items() if not u]
poses = [
 ('a small cheerful wave','warm gentle smile','head tipped left','look at camera'),
 ('a tiny finger heart beside her cheek','playful closed-lip smile','head tipped right','look at camera'),
 ('a relaxed peace sign near her face','bright smile','chin gently lowered','look at camera'),
 ('a light step forward with one hand at her hip','shy smile','head turned three-quarters','look back at camera'),
 ('one hand on her heart and the other waving','affectionate smile','head slightly tilted','look at camera'),
 ('a small celebratory pose with both hands raised','delighted expression','chin gently raised','look slightly above camera'),
 ('touching a hair ornament with ankles crossed','soft amused smile','head turned three-quarters','glance back to camera'),
 ('one hand extended in invitation','welcoming smile','head upright','look at camera'),
 ('a little side step with the skirt swaying','laughing smile','head turned slightly left','look off camera'),
 ('one fingertip on her cheek','curious half-smile','head tilted right','look at camera'),
 ('hands behind her back and a small forward lean','bashful smile','head tilted left','look at camera'),
 ('a tiny heart with both hands at chest height','sweet smile','head upright','look at camera'),
]
# Youthful game designs become adult costume interpretations on the same adult model.
youthful = {'Corin Wickes','Ellen Joe','Ju Fufu','Koleda Belobog','Nekomiya Mana','Piper Wheel','Soukaku','Sunna','Zhao'}
rows=[]
for i,name in enumerate(names):
    slug = re.sub(r'[^a-z0-9]+','-',name.lower()).strip('-')
    for variant in (1,2):
        action,expression,head,gaze=poses[(i*3+(variant-1)*5)%len(poses)]
        prompt=(
            'Use case: photorealistic natural fashion portrait. Make one full-body REAL CAMERA photograph of the SAME adult woman in image 1, about age 30, retaining her facial structure and identity. '
            f'She is wearing a real-world cosplay inspired by {name} from Zenless Zone Zero. Image 2 is a costume reference for signature hair, palette, layers, materials and accessories; do not copy its illustrated face or body. '
            'Translate the outfit into wearable detailed opaque, fully lined adult fashion with realistic fabric, seams, jewelry and natural skin texture. '
            'If the character design uses a dress or skirt, adapt it to an opaque short above-knee skirt with bare uncovered legs, no tights, stockings or knee socks. If it uses trousers or shorts, preserve that recognizable lower silhouette. '
            + ('Portray the model as a clearly mature adult of ordinary adult proportions and adapt the youthful source design appropriately. ' if name in youthful else '')
            + f'Variant {variant}: {action}; {expression}; {head}; {gaze}. Natural cute pose, visually different from the other variant. '
            'Entire figure, hair through shoes, with generous clear margins. One person only. Real transparent PNG background with clean alpha edges. No scenery, floor, typography, watermark or extra people. Studio photographic lighting. No anime drawing, CGI or game render.'
        )
        rows.append({'character':name,'slug':slug,'variant':variant,'referenceFile':str(REFS/(slug+'.webp')),'referenceUrl':urls[name],'target':str(ROOT/'images'/slug/f'look_{variant:02}.png'),'pose':{'action':action,'expression':expression,'head':head,'gaze':gaze},'prompt':prompt})

def download(name):
    slug=re.sub(r'[^a-z0-9]+','-',name.lower()).strip('-')
    p=REFS/(slug+'.webp')
    if not p.exists():
        r=requests.get(urls[name],timeout=40)
        r.raise_for_status()
        if not r.headers.get('content-type','').startswith('image/'):
            raise ValueError((name,r.headers.get('content-type')))
        p.write_bytes(r.content)
    return name,len(p.read_bytes())
with ThreadPoolExecutor(max_workers=8) as pool:
    for future in as_completed([pool.submit(download,n) for n in names]):
        print(*future.result())
plan={'asOf':'2026-09-26','source':'https://zenless-zone-zero.fandom.com/wiki/Category:Female_Agents','faceReference':FACE,'totalCharacters':len(names),'totalImages':len(rows),'images':rows}
(ROOT/'generation-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2))
print('planned',len(names),len(rows))
