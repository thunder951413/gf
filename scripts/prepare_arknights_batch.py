import concurrent.futures
import datetime
import html
import json
import re
import time
from pathlib import Path
from urllib.parse import quote, urljoin

import requests


ROOT = Path('/Users/surfing/tools/life/output/arknights_short_skirt')
SOURCE = 'https://arknights.wiki.gg/wiki/Operator/List'
FACE = ROOT / 'face_reference.png'
TODAY = datetime.date(2026, 9, 26)
ROOT.mkdir(parents=True, exist_ok=True)
REFS = ROOT / 'references'
REFS.mkdir(exist_ok=True)

page = requests.get(SOURCE, timeout=40)
page.raise_for_status()
(ROOT / 'operator-list.html').write_bytes(page.content)
markup = page.text
rows = []
for section, end in [('EN_Operators', 'CN_Operators'), ('CN_Operators', None)]:
    chunk = markup.split(f'id="{section}"', 1)[1]
    if end:
        chunk = chunk.split(f'id="{end}"', 1)[0]
    for match in re.finditer(r'<tr>\s*(.*?)</tr>', chunk, re.S):
        row = match.group(1)
        if 'field_Gender">Female' not in row:
            continue
        name = re.search(r'<td class="field_Name"><a href="([^"]+)" title="([^"]+)"', row)
        date = re.search(r'<td class="field_(?:EN|CN)_Release">([^<]+)', row)
        if not name:
            continue
        released = date.group(1) if date else None
        if released and re.fullmatch(r'\d{4}-\d{2}-\d{2}', released) and datetime.date.fromisoformat(released) > TODAY:
            continue
        title = html.unescape(name.group(2))
        url = urljoin(SOURCE, name.group(1))
        slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
        rows.append({'character': title, 'slug': slug, 'server': section[:2], 'release': released, 'detailUrl': url})

def reference(row):
    dest = REFS / f"{row['slug']}.png"
    if dest.exists() and dest.stat().st_size > 10000:
        return str(dest)
    file_name = quote(row['character'].replace(' ', '_') + '.png', safe='_-')
    url = f'https://arknights.wiki.gg/images/{file_name}'
    for attempt in range(3):
        try:
            image = requests.get(url, timeout=35)
            if image.ok and image.headers.get('content-type', '').startswith('image/') and len(image.content) > 10000:
                dest.write_bytes(image.content)
                return str(dest)
        except requests.RequestException:
            pass
        time.sleep(2 + attempt * 3)
    return None

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    paths = list(executor.map(reference, rows))
for row, path in zip(rows, paths):
    row['referenceFile'] = path

(ROOT / 'roster.json').write_text(json.dumps({
    'asOf': str(TODAY), 'source': SOURCE, 'totalCharacters': len(rows), 'characters': rows,
}, ensure_ascii=False, indent=2))
print('characters', len(rows), 'references', sum(bool(p) for p in paths))
print('missing', [row['character'] for row in rows if not row['referenceFile']])
