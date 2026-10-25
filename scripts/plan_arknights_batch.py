import json
from pathlib import Path


ROOT = Path('/Users/surfing/tools/life/output/arknights_short_skirt')
roster = json.loads((ROOT / 'roster.json').read_text())['characters']
FACE = str(ROOT / 'face_reference.png')
POSES = [
    ('a small cheerful wave', 'warm smile', 'head gently tilted left'),
    ('a tiny finger heart beside her cheek', 'playful smile', 'head tilted right'),
    ('a relaxed peace sign near one shoulder', 'bright smile', 'chin slightly lowered'),
    ('one hand touching a hair ornament', 'soft smile', 'head turned three-quarters'),
    ('a light side step with skirt swaying', 'joyful smile', 'look back toward camera'),
    ('hands behind her back and a slight forward lean', 'shy smile', 'head tipped left'),
    ('a small wave over one shoulder', 'cheerful smile', 'head turned back'),
    ('both hands making a small heart at chest height', 'sweet smile', 'head upright'),
    ('one hand resting softly over her heart', 'gentle smile', 'head tipped right'),
    ('a playful step with one foot lifted slightly', 'delighted smile', 'look at camera'),
]
images = []
for index, row in enumerate(roster):
    for variant in (1, 2):
        action, expression, head = POSES[(index * 3 + (variant - 1) * 4) % len(POSES)]
        target = ROOT / 'images' / row['slug'] / f'look_{variant:02}.png'
        prompt = (
            'Use case: identity-preserve photorealistic cosplay. Asset: full-body transparent character cutout. '
            f'Image 1 is the real woman whose facial identity must be preserved; portray her as a clearly adult woman around age 30. '
            f'Image 2 is {row["character"]} from Arknights, used only for costume, hair color and style, signature accessories and palette, not its illustrated face or age. '
            'Create a realistic camera photograph of this one adult woman wearing a detailed, wearable cosplay inspired by that character. '
            'Adapt the lower outfit into an opaque, fully lined mid-thigh mini skirt, with legs uncovered from skirt hem to low shoes or ankle boots; no trousers, leggings, tights, stockings or high boots. '
            'The skirt must cover appropriately during the pose; no underwear visible. Keep the upper clothing, hair, ornament and colors recognizable. '
            f'Pose: {action}; {expression}; {head}. A natural charming standing pose, distinct from the other variant. '
            'Show one complete adult figure from hair to shoe soles with margin. Realistic fabric, stitching, jewelry, skin texture and soft studio light. '
            'Actual transparent PNG background, clean edges; no scenery, floor, text, logos, watermark, weapons or extra people. '
            'No drawing, anime, CGI or game render.'
        )
        images.append({**row, 'variant': variant, 'target': str(target),
                       'pose': {'action': action, 'expression': expression, 'head': head},
                       'prompt': prompt})

(ROOT / 'generation-plan.json').write_text(json.dumps({
    'asOf': '2026-09-26', 'source': 'https://arknights.wiki.gg/wiki/Operator/List',
    'faceReference': FACE, 'totalCharacters': len(roster), 'totalImages': len(images),
    'images': images,
}, ensure_ascii=False, indent=2))
print(len(roster), len(images))
