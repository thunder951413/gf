# 林晓薇 · 写实人物样稿 v1

使用内置 image_gen 生成。参考当前头像，统一脸部、发型、格纹衬衫、白色内搭、浅蓝牛仔裤和白鞋。当前交付仅用于检查人物观感和不同姿态的一致性，未改动桌面程序或聊天数据。

- idle.png：日常站姿。
- reading.png：坐在木椅上看书。

## 检查结果

两张图均为 1024×1536 RGB 静态图。已检查脸部观感、服装与全身构图。虽然提示词要求透明背景，工具实际输出了不透明的棋盘格底图；额外背景提取尝试仍未得到真正 alpha，因此不能作为已经完成的透明桌面素材使用。尚未制作分层、眨眼、呼吸或姿态过渡动画。

## 站姿完整提示词

Use case: identity-preserve.
Asset type: first production-quality still asset for a photorealistic desktop companion, not a UI mockup.
Reference image: the provided local portrait is the identity and photographic-style reference. Preserve her recognizable facial proportions, almond eyes, eyebrows, nose, lips, straight long dark hair with wispy fringe, small gold stud earrings and East Asian appearance. Depict her clearly as a 27-year-old adult woman. Match the reference person as closely as possible rather than inventing a different attractive face.
Create ONE full-body, head-to-shoes portrait of this same woman, standing naturally with relaxed shoulders, weight slightly on one leg, hands gently together near her waist, looking toward the viewer with a small warm, natural smile. Adult natural body proportions.
Wardrobe: the same understated brown/charcoal small-check open overshirt seen in the reference, a plain ivory cotton crewneck top underneath, straight light-blue jeans and simple off-white sneakers. Sleeves gently rolled. No logos.
Photographic realism at the quality of the reference: fine natural hair strands, soft skin texture, believable fabric folds, anatomically correct hands and feet. Soft warm window light from upper left, gentle fill, no harsh highlights. No doll, no toy, no plastic skin, no 3D render, no anime, no illustration.
Isolate the entire woman on a genuinely transparent alpha background, including clean natural hair edges. No room, no scenery, no ground rectangle, no cast shadow outside the silhouette, no lettering, no watermark, no checkerboard painted into the image. Keep the whole head, hair, hands and shoes in frame with modest transparent margin. Vertical portrait canvas, high resolution. This is a clean cutout to float on a computer desktop.

## 阅读姿态完整提示词

Use case: identity-preserve.
Asset type: second still asset for the same photorealistic desktop companion.
Input 1 is the authoritative facial identity reference. Input 2 is the approved full-body wardrobe and body-proportion reference. Preserve the same recognizable 27-year-old adult East Asian woman, her face, long straight dark hair with wispy fringe, small gold stud earrings, and EXACTLY the same brown/charcoal small-check overshirt over ivory crewneck top, straight light-blue jeans and off-white sneakers from Input 2. No change of identity or age.
Change the pose: she is sitting comfortably on a simple light oak chair with a small cream seat cushion, viewed from a gentle three-quarter front angle. Legs relaxed, both feet visible and resting naturally. She holds an open small paperback book on her lap with both hands, head tilted slightly down, eyes naturally reading the pages, quiet contented expression. Her face remains clearly recognizable and visible. Believable fingers supporting the book, correct anatomy.
Render a full-body high-resolution photographic cutout of the woman AND chair and book. Match Input 2's photographic skin and hair fidelity, warm soft daylight from upper left and clothing colors. No harsh spotlights. Include the entire head, hair, chair and shoes without cropping, natural adult proportions.
Genuinely transparent background with an alpha channel. No scene, room, floor rectangle, wallpaper, text or watermark. Do not reproduce the checkerboard visible in reference previews as image content. Clean cutout hair edges. One person, one pose, vertical portrait canvas. Not anime, illustration, doll or 3D render.

## 背景提取尝试提示词（未采用）

Use case: background-extraction.
Edit target: the supplied full-body standing woman image.
Remove the entire gray checkerboard background. Return a PNG cutout with a REAL alpha transparency channel, with background pixels alpha 0. The checkerboard in the source is currently baked into an opaque RGB image and must be deleted, not repainted or represented visually.
Preserve the woman exactly: same face, hair, expression, pose, checkered brown shirt (this belongs to her and must NOT be removed), white top, jeans, hands and shoes. Preserve original framing and resolution. Keep wispy hair edges. Do not alter the person or create a new photo. No room, no shadows around the figure, no text. The deliverable is an isolated full body with genuine transparency, not a photograph of a transparency checkerboard.
