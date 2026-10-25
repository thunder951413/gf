import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1] / 'output' / 'azur_lane_one_each'
ALL = json.loads((ROOT / 'generation-plan.json').read_text())['entries']
BY_NAME = {item['name']: item for item in ALL if item['name'] != 'Enterprise' or item['shipId'] == '10706'}

# Popular 2025 poll finalists/qualifiers plus earlier Hall of Fame and enduring favorites.
# Adult real-person interpretations only, including for youthful source designs.
NAMES = [
    'Enterprise', 'Yorktown', 'Essex', 'Hood', 'King George V', 'Bismarck',
    'New Jersey', 'Belfast', 'Prinz Eugen', 'Atago', 'Akagi', 'Kaga', 'Taihou',
    'Shinano', 'Musashi', 'Unzen', 'Hindenburg', 'Friedrich der Große',
    'Ulrich von Hutten', 'Ägir', 'Anchorage', 'Kearsarge', 'Guam',
    'Illustrious', 'Formidable', 'Implacable', 'Perseus', 'Cheshire',
    'Sirius', 'Dido', 'Prince of Wales', 'Richelieu', 'Alsace', 'Mogador',
    'Jean Bart', 'Dunkerque', 'Vittorio Veneto', 'Zara', 'Helena',
    'Baltimore', 'Bremerton', 'Roon', 'Amagi', 'Noshiro', 'Sovetsky Soyuz',
    'Albion', 'Lion', 'Admiral Nakhimov', 'Hakuhou', 'Yat Sen',
]
assert len(NAMES) == len(set(NAMES)) == 50
assert all(name in BY_NAME for name in NAMES)

POSES = [
    ('small wave at shoulder height', 'gentle smile', 'head tilted left'),
    ('one hand lightly touching her hair', 'playful smile', 'head tilted right'),
    ('one hand resting at her waist', 'warm smile', 'head turned three-quarters'),
    ('hands lightly clasped in front', 'soft smile', 'chin slightly lowered'),
    ('one hand making a subtle peace sign', 'cheerful smile', 'head upright'),
    ('one hand touching her hat or head ornament', 'quiet smile', 'head angled slightly'),
    ('a small step forward with arms relaxed', 'bright smile', 'gaze slightly to the side'),
    ('one hand over her heart', 'kind smile', 'head gently tilted'),
    ('both hands relaxed beside her', 'confident smile', 'chin slightly raised'),
    ('one hand making a tiny finger heart at chest height', 'sweet smile', 'head turned slightly'),
]

refs = ROOT / 'references' / 'top50'
refs.mkdir(parents=True, exist_ok=True)

def fetch(item):
    path = refs / f"{item['shipId']}.png"
    if not path.exists():
        response = requests.get(item['referenceUrl'], timeout=60)
        response.raise_for_status()
        if not response.headers.get('content-type', '').startswith('image/'):
            raise ValueError(f"Not an image: {item['name']}")
        path.write_bytes(response.content)
    return path

items = [BY_NAME[name] for name in NAMES]
with ThreadPoolExecutor(max_workers=8) as pool:
    futures = {pool.submit(fetch, item): item for item in items}
    for future in as_completed(futures):
        future.result()

rows = []
for i, item in enumerate(items):
    action, expression, head = POSES[i % len(POSES)]
    rows.append({
        'position': i + 1,
        'shipId': item['shipId'],
        'name': item['name'],
        'referenceFile': str(refs / f"{item['shipId']}.png"),
        'target': str(ROOT / item['output']),
        'status': 'complete' if (ROOT / item['output']).exists() else 'pending',
        'pose': {'action': action, 'expression': expression, 'head': head},
    })

plan = {
    'asOf': '2026-09-27',
    'selectionBasis': [
        'https://wiki.biligame.com/blhx/2025年舰船人气投票活动',
        'https://azurlane.yo-star.com/news/2025/12/03/maintenance-notice-12-4-12-a-m-utc-7/',
    ],
    'selectionNote': 'Curated popular 50 across 2025 voting and earlier Hall of Fame; not an exact single-poll ranking.',
    'faceReference': str(ROOT / 'face_reference.png'),
    'totalImages': 50,
    'images': rows,
}
(ROOT / 'top50-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2))
print('Prepared 50; complete:', sum(row['status'] == 'complete' for row in rows))
