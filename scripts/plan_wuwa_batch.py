import json
from pathlib import Path


ROOT = Path('/Users/surfing/tools/life/output/wuwa_female_photoreal')
FACE = '/var/folders/1d/wnwk03995qn1wrnwjwg_bdjw0000gn/T/codex-clipboard-2ad013a6-5f1f-48ec-906b-74d02e8bcb12.png'
roster = json.loads((ROOT / 'roster.json').read_text())['characters']

POSES = [
    ('give a small cheerful wave with one hand', 'warm gentle smile', 'head tipped slightly left', 'look at camera'),
    ('make a tiny finger heart beside her cheek', 'playful closed-lip smile', 'head tipped slightly right', 'look at camera'),
    ('hold a soft double peace sign near the shoulders', 'bright open smile', 'chin gently lowered', 'look at camera'),
    ('take a light step forward, one hand holding the edge of her outfit', 'shy smile', 'look over one shoulder', 'look back at camera'),
    ('place one hand over her heart and wave with the other', 'affectionate smile', 'head slightly tilted', 'look at camera'),
    ('lift both hands in a small celebratory pose', 'delighted expression', 'chin gently raised', 'look slightly above camera'),
    ('touch a hair ornament while standing with ankles crossed', 'soft amused smile', 'head turned three-quarters', 'glance back toward camera'),
    ('hold out a hand as if inviting a friend to join', 'welcoming smile', 'head upright', 'look at camera'),
    ('do a little side step with skirt or coat swaying naturally', 'laughing smile', 'head turned slightly left', 'look off camera'),
    ('rest one fingertip on her cheek in a thoughtful cute pose', 'curious half-smile', 'head tilted right', 'look at camera'),
    ('hold both hands behind her back and lean forward slightly', 'bashful smile', 'head tilted left', 'look at camera'),
    ('make a relaxed peace sign near one eye', 'mischievous smile', 'head turned three-quarters', 'look at camera'),
    ('hold a small imaginary note or charm near her chest', 'tender smile', 'chin lowered slightly', 'look down at hands'),
    ('wave over one shoulder while taking a small step away', 'cheerful smile', 'head turned back', 'look at camera'),
    ('make a tiny heart with both hands at chest height', 'sweet smile', 'head upright', 'look at camera'),
    ('stand on one foot for a light playful step, arms softly out for balance', 'delighted smile', 'head tipped right', 'look at camera'),
]

images = []
for i, row in enumerate(roster):
    for variant in (1, 2):
        pose = POSES[(i * 3 + (variant - 1) * 5) % len(POSES)]
        action, expression, head, gaze = pose
        target = ROOT / 'images' / row['slug'] / f'look_{variant:02}.png'
        young = row['character'] in {'Verina', 'Encore', 'Youhu', 'Lumi', 'Roccia', 'Rebecca', 'Buling', 'Suisui'}
        prompt = (
            'Use case: photorealistic-natural. Asset type: transparent character cutout for a local portrait app. '
            f'Create a full-body REAL CAMERA photograph of the SAME woman shown in image 1, an adult around age 30 with consistent facial features, cosplaying {row["character"]} from Wuthering Waves. '
            'Image 1 is the facial identity reference. Image 2 shows the character design and is ONLY a reference for outfit silhouette, hair color and style, signature accessories, materials and palette. '
            + ('For Rover, image 2 has two figures: use ONLY the female figure on the right as the costume reference; never include the male figure. ' if row['character'] == 'Rover (Female)' else '')
            + 'Translate the game design into detailed wearable real-world cosplay with natural skin texture and realistic fabric, stitching and jewelry. '
            'Use opaque fully lined garments and a tasteful adult fashion fit. '
            + ('The game character has a youthful design, but portray the woman as a clearly adult person of normal adult height and proportions; adapt the outfit modestly. ' if young else '')
            + 'Her face must remain the woman in image 1, not the illustrated face. One person only. '
            f'Variant {variant}: {action}; {expression}; {head}; {gaze}. Make the motion natural, charming and distinct from the other variant. '
            'Entire figure from hair to shoe soles visible with ample margin; no cropped limbs or props. '
            'Genuine transparent PNG background with clean alpha edges, no scenery, floor, text, logo, watermark or extra people. '
            'Soft photographic studio lighting. No anime drawing, CGI, illustration or game render.'
        )
        images.append({
            'character': row['character'], 'slug': row['slug'], 'element': row['element'],
            'debut': row['debut'], 'variant': variant, 'target': str(target),
            'referenceFile': row['referenceFile'],
            'pose': {'action': action, 'expression': expression, 'head': head, 'gaze': gaze},
            'prompt': prompt,
        })

plan = {
    'asOf': '2026-09-26', 'source': 'https://wutheringwaves.party/en/resonators/',
    'faceReference': FACE, 'totalCharacters': len(roster),
    'totalImages': len(images), 'images': images,
}
(ROOT / 'generation-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2))
print(len(roster), len(images))
