/**
 * AI style presets: the image-edit model restyles the source image into one
 * of these looks before the other views are generated. Every prompt keeps the
 * subject's identity, features and clothing and asks for a clean studio
 * render that 3D reconstruction can use; keeping the pose and composition
 * (STYLE_KEEP_POSE) is added by buildPrepPrompt only when no T-pose / body
 * completion is asked for. No brand or trademark names, nor descriptions of
 * protected product shapes.
 */
import type { I18nText } from '../core/types';
import type { StyleCategory, StylePreset } from './types';

/** Appended to every look: keep who / what it is, and make it reconstructable. */
export const STYLE_KEEP =
  'Preserve the subject’s identity, recognisable features and clothing. Render it as a clean studio shot on a plain background with soft, even lighting and the whole subject in frame, suitable for 3D reconstruction.';

/** Added after a style when the pose and framing must stay (no T-pose / body completion). */
export const STYLE_KEEP_POSE = 'Keep the original pose and composition.';

export const STYLE_CATEGORIES: { id: StyleCategory; name: I18nText }[] = [
  { id: 'realistic', name: { tr: 'Gerçekçi', en: 'Realistic' } },
  { id: 'animated', name: { tr: 'Animasyon', en: 'Animated' } },
  { id: 'toy', name: { tr: 'Oyuncak', en: 'Toy' } },
  { id: 'material', name: { tr: 'Malzeme', en: 'Material' } },
  { id: 'artistic', name: { tr: 'Sanatsal', en: 'Artistic' } },
  { id: 'game', name: { tr: 'Oyun', en: 'Game' } },
];

const g = (a: string, b: string, c?: string) => `linear-gradient(135deg, ${a} 0%, ${c ? `${b} 50%, ${c} 100%` : `${b} 100%`})`;

function s(id: string, tr: string, en: string, category: StyleCategory, look: string, swatch: string): StylePreset {
  return { id, name: { tr, en }, category, prompt: `Restyle the subject as ${look}. ${STYLE_KEEP}`, swatch };
}

export const STYLES: StylePreset[] = [
  // Realistic
  s('photoreal', 'Fotogerçekçi', 'Photorealistic', 'realistic', 'a photorealistic studio photograph with true-to-life materials, skin and fabric textures and natural colours', g('#c9b8a8', '#7d6b5d')),
  s('cinematic', 'Sinematik', 'Cinematic', 'realistic', 'a cinematic film still with rich but natural colour grading, a soft key light and a subtle rim light', g('#1f3b4d', '#d98e4a')),
  s('hyper-sculpt', 'Hiper detaylı heykel', 'Hyper-detailed sculpt', 'realistic', 'a hyper-detailed high-resolution digital sculpture with fine pores, wrinkles and fabric folds, finely painted', g('#8a8f98', '#d6c7b0')),
  s('clay-render', 'Kil render', 'Clay render', 'realistic', 'an untextured matte light-grey clay render that shows the pure sculpted form', g('#e2e2e2', '#9a9a9a')),
  s('pbr-asset', 'PBR oyun varlığı', 'PBR game asset', 'realistic', 'a realistic PBR 3D asset with clean albedo colours, subtle roughness variation and no baked-in shadows', g('#56626e', '#b5a48b')),
  s('resin-statue', 'Reçine koleksiyon heykeli', 'Resin collector statue', 'realistic', 'a premium hand-painted resin collector statue with realistic proportions and fine paintwork', g('#4b3b2f', '#c7a27c')),

  // Animated
  s('animated-film', '3B animasyon filmi', '3D animated film', 'animated', 'a character from a high-quality 3D animated feature film: appealing stylised proportions, large expressive eyes, soft skin shading and smooth clean shapes', g('#ffb86b', '#ff6f91', '#845ec2')),
  s('anime', 'Anime', 'Anime', 'animated', 'an anime-style 3D toon model with crisp shapes, large expressive eyes and flat cel colours', g('#ff9ecd', '#8ec5ff')),
  s('chibi', 'Chibi', 'Chibi', 'animated', 'a chibi character: a big head about one third of the total height, a small body and cute rounded features', g('#ffd1dc', '#ffe8a3')),
  s('cartoon', 'Çizgi film', 'Cartoon', 'animated', 'a classic 3D cartoon character with bold simplified shapes, bright saturated colours and playful exaggerated features', g('#ffde59', '#ff5757')),
  s('cel-shaded', 'Cel-shaded', 'Cel-shaded', 'animated', 'a cel-shaded 3D model with flat colour bands and clean dark outlines', g('#2d3047', '#e0e0e0')),
  s('claymation', 'Kil animasyon', 'Claymation', 'animated', 'a handmade plasticine claymation figure with visible fingerprints and soft rounded forms', g('#e07a5f', '#f2cc8f', '#81b29a')),
  s('stop-motion', 'Stop-motion kukla', 'Stop-motion puppet', 'animated', 'a stop-motion puppet with a felt and fabric costume, tiny stitched details and bead eyes', g('#6d597a', '#e56b6f')),
  s('storybook', 'Masal kitabı 3B', 'Storybook 3D', 'animated', 'a whimsical storybook 3D character with soft painterly textures and gentle pastel colours', g('#b8e0d2', '#eac4d5')),
  s('kawaii-mascot', 'Sevimli maskot', 'Cute mascot', 'animated', 'a cute kawaii mascot with round soft shapes and a simple friendly face', g('#fcd5ce', '#a0e7e5')),

  // Toy
  s('vinyl-figure', 'Vinil koleksiyon figürü', 'Vinyl collectible figure', 'toy', 'a glossy vinyl collectible figure with a slightly oversized head, simplified features and smooth plastic surfaces', g('#ff7b54', '#ffb26b', '#ffd56b')),
  s('block-toy', 'Blok oyuncak figür', 'Blocky toy figure', 'toy', 'a chunky stylized toy figure built from simple geometric plastic blocks, with blocky limbs, flat colours and a glossy plastic finish', g('#4fb3ff', '#ff8a3d')),
  s('plush', 'Peluş oyuncak', 'Plush toy', 'toy', 'a soft plush toy made of fuzzy fabric with visible seams, embroidered eyes and stuffed rounded limbs', g('#f6d6ad', '#e8a87c')),
  s('action-figure', 'Aksiyon figürü', 'Action figure', 'toy', 'an articulated plastic action figure with visible joints, sculpted details and factory paint', g('#3a506b', '#5bc0be')),
  s('bobblehead', 'Sallanan kafa figürü', 'Bobblehead', 'toy', 'a bobblehead figurine with a big oversized head on a small body, in glossy painted resin', g('#f4a261', '#2a9d8f')),
  s('wooden-toy', 'Ahşap oyuncak', 'Wooden toy', 'toy', 'a hand-made painted wooden toy with simple rounded shapes and visible wood grain', g('#d4a373', '#faedcd')),
  s('tabletop-mini', 'Masaüstü oyun minyatürü', 'Tabletop miniature', 'toy', 'a hand-painted tabletop gaming miniature with crisp sculpted details standing on a small round base', g('#495057', '#adb5bd', '#c9a227')),
  s('blind-box', 'Sürpriz kutu figürü', 'Blind-box figure', 'toy', 'a cute blind-box designer figure with chubby proportions, a big head and pastel matte plastic', g('#cdb4db', '#ffc8dd', '#bde0fe')),
  s('tin-toy', 'Teneke oyuncak', 'Vintage tin toy', 'toy', 'a vintage wind-up tin toy with printed metal panels, rivets and a slightly worn finish', g('#9b2226', '#e9d8a6')),

  // Material
  s('marble', 'Mermer heykel', 'Marble statue', 'material', 'a classical white marble statue with subtle veining and polished stone surfaces, carved as one piece', g('#f8f9fa', '#ced4da')),
  s('bronze', 'Bronz', 'Bronze', 'material', 'a cast bronze sculpture with a warm metallic patina and polished highlights', g('#8c5a2b', '#cd7f32')),
  s('gold', 'Altın', 'Gold', 'material', 'a solid polished gold sculpture with smooth reflective metallic surfaces', g('#b8860b', '#ffd700')),
  s('porcelain', 'Porselen', 'Porcelain', 'material', 'a glazed white porcelain figurine with delicate blue painted accents and a glossy finish', g('#ffffff', '#a9c6e8')),
  s('glass', 'Cam', 'Glass', 'material', 'a blown-glass sculpture with smooth refractive surfaces, slightly frosted so the form stays readable', g('#d8f3ff', '#8ecae6')),
  s('crystal', 'Kristal', 'Crystal', 'material', 'a faceted crystal sculpture with sharp cut facets, slightly frosted so the form stays readable', g('#e0c3fc', '#8ec5fc')),
  s('wood-carving', 'Ahşap oyma', 'Wood carving', 'material', 'a hand-carved wooden sculpture with visible chisel marks and natural wood grain', g('#7f5539', '#b08968')),
  s('stone', 'Taş', 'Stone', 'material', 'a carved granite statue with a rough weathered stone surface', g('#6c757d', '#a8a29e')),
  s('ice', 'Buz', 'Ice', 'material', 'an ice sculpture carved from a block of ice, with a frosty surface that keeps the form readable', g('#caf0f8', '#90e0ef')),
  s('chrome', 'Krom', 'Chrome', 'material', 'a mirror-polished chrome sculpture with smooth reflective surfaces', g('#dee2e6', '#6c757d', '#f8f9fa')),
  s('jade', 'Yeşim', 'Jade', 'material', 'a carved green jade figurine with a soft polished, slightly translucent finish', g('#2d6a4f', '#95d5b2')),
  s('terracotta', 'Pişmiş toprak', 'Terracotta', 'material', 'a terracotta clay sculpture with a matte earthy orange surface', g('#9c4a1a', '#e07a3f')),
  s('paper-craft', 'Kağıt işi', 'Paper craft', 'material', 'a layered paper-craft model made of folded and glued coloured card', g('#f28482', '#84a59d', '#f6bd60')),
  s('origami', 'Origami', 'Origami', 'material', 'an origami figure folded from paper, with crisp creases and flat paper planes', g('#f5ebe0', '#e3d5ca')),
  s('knitted', 'Örgü yün', 'Knitted wool', 'material', 'a hand-knitted wool toy with visible stitches and soft yarn texture', g('#e5989b', '#b5838d')),
  s('balloon', 'Balon', 'Balloon', 'material', 'a balloon-art figure made of shiny inflated latex balloons', g('#ff006e', '#8338ec', '#3a86ff')),
  s('candy', 'Şeker', 'Candy', 'material', 'a sculpture made of glossy hard candy and sugar icing in bright colours', g('#ff99c8', '#fcf6bd', '#a9def9')),
  s('low-poly', 'Low-poly', 'Low-poly', 'material', 'a low-poly 3D model with flat-shaded triangular facets and a limited colour palette', g('#264653', '#2a9d8f', '#e9c46a')),
  s('voxel', 'Voksel', 'Voxel', 'material', 'voxel art built from small uniform cubes, with a blocky, pixel-like 3D look', g('#57cc99', '#38a3a5', '#22577a')),

  // Artistic
  s('watercolor', 'Suluboya', 'Watercolor', 'artistic', 'a 3D figure painted in watercolor, with soft washes of colour and paper-like texture on its surfaces', g('#a8dadc', '#f1faee', '#e63946')),
  s('oil-painting', 'Yağlı boya', 'Oil painting', 'artistic', 'a 3D figure with oil-painted surfaces, visible brush strokes and rich colours', g('#3d405b', '#e07a5f', '#f2cc8f')),
  s('comic', 'Çizgi roman', 'Comic book', 'artistic', 'a comic-book style 3D figure with bold ink outlines, halftone shading and vivid colours', g('#ffbe0b', '#fb5607', '#3a86ff')),
  s('pixel-3d', 'Piksel sanatı 3B', 'Pixel-art 3D', 'artistic', 'pixel art turned into 3D: chunky square pixels extruded into blocks with a limited palette', g('#06d6a0', '#118ab2', '#ef476f')),
  s('sketch', 'Karakalem', 'Pencil sketch', 'artistic', 'a pencil sketch wrapped over the 3D forms, graphite hatching on white', g('#ffffff', '#6c757d')),
  s('pop-art', 'Pop art', 'Pop art', 'artistic', 'a pop-art 3D figure with flat bold colours and graphic shapes', g('#ff006e', '#ffbe0b', '#3a86ff')),

  // Game
  s('stylized-hero', 'Stilize oyun kahramanı', 'Stylized game hero', 'game', 'a stylized hand-painted game hero with chunky proportions, bold silhouette and painted textures', g('#4361ee', '#f72585')),
  s('retro-32bit', 'Retro 32-bit low-poly', 'Retro 32-bit low-poly', 'game', 'a retro 32-bit console era low-poly character with low-resolution textures', g('#5a189a', '#ff9e00')),
  s('scifi-armor', 'Bilimkurgu zırhı', 'Sci-fi armor', 'game', 'a character in futuristic sci-fi armour with hard-surface panels, glowing accents and metal details', g('#0b132b', '#3a506b', '#5bc0be')),
  s('fantasy-rpg', 'Fantastik RPG', 'Fantasy RPG', 'game', 'a fantasy RPG character in ornate armour and robes with leather, metal and cloth details', g('#5f0f40', '#9a031e', '#fb8b24')),
  s('cyberpunk', 'Cyberpunk', 'Cyberpunk', 'game', 'a cyberpunk character with neon accents, techwear clothing and subtle cybernetic implants', g('#f72585', '#7209b7', '#4cc9f0')),
  s('steampunk', 'Steampunk', 'Steampunk', 'game', 'a steampunk character with brass gears, leather straps, goggles and Victorian-era clothing', g('#6f4518', '#bc8a5f', '#e7bc91')),
  s('mecha', 'Mekanik robot', 'Mecha', 'game', 'a giant mecha robot version with armoured mechanical plates, visible joints and pistons', g('#343a40', '#adb5bd', '#e63946')),
  s('zombie', 'Zombi', 'Zombie', 'game', 'a stylized, non-gory zombie version with pale greenish skin and tattered clothes', g('#4f772d', '#90a955', '#31572c')),
  s('superhero', 'Süper kahraman', 'Superhero', 'game', 'an original superhero in a sleek emblem-free costume with a heroic look', g('#1d3557', '#e63946')),
  s('knight', 'Ortaçağ şövalyesi', 'Medieval knight', 'game', 'a medieval knight in full plate armour with a surcoat', g('#495057', '#ced4da', '#9d0208')),
  s('samurai', 'Samuray', 'Samurai', 'game', 'a samurai in lacquered layered armour', g('#370617', '#9d0208', '#ffba08')),
];

const BY_ID = new Map(STYLES.map((st) => [st.id, st]));

/** Renamed presets (saved options may still name the old id). */
const ALIASES: Record<string, string> = { 'brick-minifig': 'block-toy' };

export function getStyle(id: string | null): StylePreset | null {
  return id ? BY_ID.get(id) ?? BY_ID.get(ALIASES[id] ?? '') ?? null : null;
}
