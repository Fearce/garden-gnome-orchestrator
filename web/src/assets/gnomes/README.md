# Beta workshop cast

`workshop-cast.webp` is the production 4 × 2 character atlas (1152 × 768, transparent alpha, 237,486 bytes). Row order: director, planner, researcher, implementor; QA, reader, reviewer, coworker.

Generated with the built-in ImageGen tool on 2026-10-01. The original 1536 × 1024 result was converted to WebP at 0.86 quality with Chromium Canvas. The alpha channel is retained. This texture is fetched only when a beta character is mounted. No CDN or runtime image service is involved.

Generation prompt:

> Use case: stylized-concept. Asset type: production game character sprite atlas for an opt-in premium gnome workshop in GGO. Create ONE transparent PNG atlas, exactly 4 equal columns by 2 equal rows, eight isolated full-body Nordic workshop gnomes, one centered per cell with ample transparent padding and identical scale, no text, no dividing lines, no scenery, no shadows extending outside each cell. All characters face front slightly three-quarter to the right. Extremely charming premium cozy fantasy game art: sculpted clay/painterly 3D, tactile wool hats with turned floppy tips, lustrous cream layered beards, peach round noses, tiny kind eyes beneath hat brims, leather belts and boots, rich volumetric lighting, warm gold rim lights, exquisite craftsmanship, readable small silhouettes. Not flat vector art, not low-fi icons, not pixel art. Hands relaxed close to sides, NO held tools, no accessories projecting sideways (tools will be animated separately in the app). Row 1 left to right: director in midnight-indigo coat and a purple pointed hat with brass star pin; planner in sapphire blue with rolled-up belt scroll; researcher in teal with little brass goggles on hat; implementor in warm amber/mustard hat and dark leather apron. Row 2 left to right: QA inspector in rose/coral with small round brass spectacles; reader in soft violet/lavender; reviewer in moss green with gold clasp; coworker in turquoise with a messenger belt pouch. All eight visibly unique faces and hat silhouettes but a cohesive art family, approximately same full-body proportions (tall hat 40%, beard 35%, small body and boots). Boots near bottom 92% of each cell, hat top near 6%; characters occupy about 70% cell width. Output a crisp transparent background sprite atlas, 1536x1024 landscape.

Alpha refinement prompt:

> Edit this sprite atlas only: remove the entire colored background so all space between and around all eight gnomes is genuinely transparent alpha (not a checkerboard drawing, not black or colored fill). Preserve the eight gnomes exactly: same locations and 4-column 2-row grid, sizes, colors, faces, fur, clothing, boots. Keep fine silhouette edges. No other changes. Production transparent sprite atlas.

## Runtime

General settings exposes the default-off browser preference `ggo:beta-gnomes`. `BetaGnome` uses the shared texture for the torso and independently posed boots. The foreground tools have distinct typing, inspection, drawing, globe, page, gavel and conducting motions. Small avatars remain static. The original `Gnome` branch and its skins remain intact when beta is off; beta rare skins have a small charm.

`BetaWorkshop` uses actual active runs, repository room routing, remote agents and online directors. It draws at most seven characters, reserves visitor slots, and provides the complete crew in an overflow roster. Speech displays real recent chat and expires after 15 seconds even without running tasks. New-message counts are per room for the current workshop visit and clear when that room is opened. No decorative animation asserts test success or task completion.

CSS moves transforms/opacity only, with one shared IntersectionObserver and visibility listener. Hidden/offscreen scenes pause, reduced motion disables animation, and the workshop has a pause button. The existing scaffold screensaver keeps its specialized rope/tool physics.

## Verification

`node web/scripts/beta-gnomes.browser.cjs` runs against the built local console (optional URL argument for Vite). It reads the local login password without logging it and intercepts the test browser's WebSocket to use fixtures; outgoing mutations never reach the live office. Checks default-off loading, General activation, persistence, crowded/remote offices, message routing and expiry, animation pause, hidden/offscreen scenes, reduced motion, four viewport sizes and cross-tab rollback. Screenshots are written to `_beta-gnomes/`.

Existing gates: `npm run test:gnome-skins --prefix server` and `node server/node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json web/scripts/office-navigation.test.tsx`.
