import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output' / 'azur_lane_one_each'
OUT.mkdir(parents=True, exist_ok=True)
SOURCE = 'https://azurlane.nagami.moe/data/ships.json'
SKINS_SOURCE = 'https://raw.githubusercontent.com/Fernando2603/AzurLane/main/ship_skin.json'

ships = requests.get(SOURCE, timeout=40).json()['ships']
skins = requests.get(SKINS_SOURCE, timeout=40).json()
if len(ships) != 875:
    raise RuntimeError(f'Expected 875 live ship entries; found {len(ships)}')

roster = []
for position, ship in enumerate(ships, 1):
    ship_id = str(ship['groupId'])
    name = ship['name']
    skin_group = skins[ship_id]
    default_skin = next((skin for skin in skin_group['skins'].values() if skin['type'] == 'Default'), None)
    if default_skin is None:
        default_skin = next(iter(skin_group['skins'].values()))
    roster.append({
        'position': position,
        'shipId': ship_id,
        'name': name,
        'sourceUrl': f'https://azurlane.nagami.moe/ships/{ship_id}',
        'referenceUrl': default_skin['painting'],
        'output': f'images/{ship_id}.png',
        'status': 'complete' if (OUT / 'images' / f'{ship_id}.png').exists() else 'pending',
    })

plan = {
    'source': SOURCE,
    'asOf': '2026-09-26',
    'faceReference': str(OUT / 'face_reference.png'),
    'referenceSource': SKINS_SOURCE,
    'totalEntries': len(roster),
    'coverageNote': 'Matches all 875 entries in the current live ship catalog. II, META and collaboration entries remain separate.',
    'description': 'One photorealistic transparent adult character portrait per ship entry; same face reference.',
    'entries': roster,
}
(OUT / 'generation-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2))
print(f'Prepared {len(roster)} entries at {OUT / "generation-plan.json"}')
