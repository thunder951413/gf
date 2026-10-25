import concurrent.futures
import json
import re
from pathlib import Path

import requests


ROOT = Path('/Users/surfing/tools/life/output/wuwa_female_photoreal')
REFS = ROOT / 'references'
REFS.mkdir(parents=True, exist_ok=True)
SOURCE = 'https://wutheringwaves.party/en/resonators/'
MALE = {
    'Jiyan', 'Calcharo', 'Lingyang', 'Yuanwu', 'Aalto', 'Mortefi',
    'Xiangli Yao', 'Brant', 'Qiuyuan', 'Luuk Herssen',
}


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


html = requests.get(SOURCE, timeout=20).text
rows = []
cards = re.findall(r'<div class="reso-card"[^>]*data-element="([^"]+)"[^>]*data-version="([^"]+)"[^>]*>\s*<div.*?<h3><a href="([^"]+)">([^<]+)</a>', html)
for element, debut, href, name in cards:
    if name in MALE:
        continue
    if name.startswith('Rover (') and name != 'Rover (Spectro)':
        continue
    if float(debut) > 3.6:
        continue
    rows.append({
        'character': 'Rover (Female)' if name == 'Rover (Spectro)' else name,
        'sourceName': name,
        'slug': 'rover-female' if name == 'Rover (Spectro)' else slug(name),
        'detailUrl': requests.compat.urljoin(SOURCE, href),
        'debut': debut,
        'element': element,
    })


def get_ref(row):
    name = row['sourceName']
    titles = ['Rover' if name.startswith('Rover (') else name]
    if name == 'Yangyang: Xuanling':
        titles = ['Yangyang: Xuanling', 'Yangyang']
    for title in titles:
        r = requests.get('https://wutheringwaves.fandom.com/api.php', params={
            'action': 'query', 'titles': title, 'prop': 'pageimages',
            'format': 'json', 'pithumbsize': '1000', 'redirects': '1',
        }, timeout=20)
        if not r.ok:
            continue
        pages = r.json().get('query', {}).get('pages', {})
        urls = [p.get('thumbnail', {}).get('source') for p in pages.values()]
        for url in urls:
            if not url:
                continue
            img = requests.get(url, timeout=30)
            if img.ok and len(img.content) > 5000:
                ext = '.png' if 'png' in img.headers.get('content-type', '') else '.jpg'
                path = REFS / (row['slug'] + ext)
                path.write_bytes(img.content)
                return str(path)
    return None


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    refs = list(pool.map(get_ref, rows))
for row, ref in zip(rows, refs):
    row['referenceFile'] = ref

ROOT.mkdir(parents=True, exist_ok=True)
(ROOT / 'roster.json').write_text(json.dumps({
    'asOf': '2026-09-26', 'source': SOURCE, 'characters': rows,
}, ensure_ascii=False, indent=2))
print('characters', len(rows), 'references', sum(bool(r) for r in refs))
print('missing', [r['character'] for r in rows if not r['referenceFile']])
