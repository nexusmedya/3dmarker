/**
 * Procedural sample images (no external assets): drawn with the Canvas 2D
 * API at any size, so the same code renders the thumbnails and the PNG
 * that goes through the normal upload path.
 */
import type { I18nText } from '../core/types';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SampleSpec {
  id: string;
  name: I18nText;
  fileName: string;
  width: number;
  height: number;
  /** Driver that shows this sample off best. */
  driverId: string;
  draw: (ctx: Ctx, w: number, h: number) => void;
}

/** Deterministic PRNG (mulberry32) so samples look the same every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Star outline with `points` tips, rounded by a thick round-joined stroke. */
function starPath(ctx: Ctx, cx: number, cy: number, outer: number, inner: number, points: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawLogo(ctx: Ctx, w: number, h: number): void {
  const s = Math.min(w, h);
  const cx = w / 2, cy = h * 0.52;
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(w * 0.15, h * 0.1, w * 0.85, h * 0.9);
  grad.addColorStop(0, '#8b5cf6');
  grad.addColorStop(0.55, '#ec4899');
  grad.addColorStop(1, '#f59e0b');
  starPath(ctx, cx, cy, s * 0.42, s * 0.2, 5);
  ctx.fillStyle = grad;
  ctx.strokeStyle = grad;
  ctx.lineJoin = 'round';
  ctx.lineWidth = s * 0.06;
  ctx.fill();
  ctx.stroke();
  // Soft top-left highlight, clipped to the star.
  ctx.save();
  starPath(ctx, cx, cy, s * 0.42, s * 0.2, 5);
  ctx.clip();
  const hl = ctx.createRadialGradient(cx - s * 0.15, cy - s * 0.2, 0, cx - s * 0.15, cy - s * 0.2, s * 0.45);
  hl.addColorStop(0, 'rgba(255,255,255,0.45)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // Inner disc with the "3D" mark.
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.01, s * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
  ctx.fillStyle = '#6d28d9';
  ctx.font = `800 ${Math.round(s * 0.13)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('3D', cx, cy + s * 0.015);
}

function drawMascot(ctx: Ctx, w: number, h: number): void {
  const s = Math.min(w, h);
  const cx = w / 2;
  ctx.clearRect(0, 0, w, h);
  const body = ctx.createLinearGradient(0, h * 0.15, 0, h * 0.9);
  body.addColorStop(0, '#5eead4');
  body.addColorStop(1, '#0d9488');
  // Feet and arms first so the body overlaps them.
  ctx.fillStyle = '#0f766e';
  for (const dx of [-0.13, 0.13]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx * s, h * 0.86, s * 0.1, s * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#14b8a6';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * s * 0.3, h * 0.6, s * 0.06, s * 0.13, side * -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // Gumdrop body with two ears.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.3, h * 0.84);
  ctx.bezierCurveTo(cx - s * 0.36, h * 0.5, cx - s * 0.3, h * 0.22, cx, h * 0.2);
  ctx.bezierCurveTo(cx + s * 0.3, h * 0.22, cx + s * 0.36, h * 0.5, cx + s * 0.3, h * 0.84);
  ctx.quadraticCurveTo(cx, h * 0.9, cx - s * 0.3, h * 0.84);
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * s * 0.17, h * 0.2, s * 0.07, s * 0.11, side * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  // Belly.
  ctx.fillStyle = 'rgba(240,253,250,0.85)';
  ctx.beginPath();
  ctx.ellipse(cx, h * 0.66, s * 0.17, s * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  // Eyes.
  for (const side of [-1, 1]) {
    const ex = cx + side * s * 0.1, ey = h * 0.42;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, ey, s * 0.06, s * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(ex + side * s * 0.01, ey + s * 0.012, s * 0.034, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex + side * s * 0.01 - s * 0.012, ey - s * 0.004, s * 0.011, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(244,114,182,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx + side * s * 0.19, h * 0.52, s * 0.045, s * 0.028, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Smile.
  ctx.strokeStyle = '#134e4a';
  ctx.lineWidth = s * 0.014;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, h * 0.5, s * 0.045, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
}

/** Ridge line y(x) as a sum of seeded sines. */
function ridge(rand: () => number, base: number, amp: number, w: number): (x: number) => number {
  const waves = Array.from({ length: 4 }, (_, i) => ({ f: (i + 1) * (0.8 + rand()) * 2 * Math.PI, p: rand() * 10, a: amp / (i + 1.3) }));
  return (x) => base - waves.reduce((acc, wv) => acc + wv.a * Math.sin((x / w) * wv.f + wv.p), 0);
}

function drawLandscape(ctx: Ctx, w: number, h: number): void {
  const rand = mulberry32(7);
  const horizon = h * 0.62;
  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1e3a8a');
  sky.addColorStop(0.55, '#7c7fd6');
  sky.addColorStop(1, '#fbbf8a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // Sun with glow.
  const sx = w * 0.68, sy = horizon - h * 0.12;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.4);
  glow.addColorStop(0, 'rgba(255,236,179,0.95)');
  glow.addColorStop(0.12, 'rgba(255,214,153,0.7)');
  glow.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff4d6';
  ctx.beginPath();
  ctx.arc(sx, sy, h * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Mountain layers, far (hazy) to near (dark).
  const layers = [
    { base: horizon - h * 0.08, amp: h * 0.12, top: '#9aa6d8', bottom: '#c3b4c9' },
    { base: horizon - h * 0.02, amp: h * 0.1, top: '#5b6aa8', bottom: '#8a86ad' },
    { base: horizon + h * 0.04, amp: h * 0.07, top: '#334a7a', bottom: '#4d5b86' },
  ];
  for (const layer of layers) {
    const y = ridge(rand, layer.base, layer.amp, w);
    const g = ctx.createLinearGradient(0, layer.base - layer.amp * 2, 0, h);
    g.addColorStop(0, layer.top);
    g.addColorStop(1, layer.bottom);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += Math.max(2, w / 200)) ctx.lineTo(x, y(x));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
  // Foreground meadow.
  const groundTop = horizon + h * 0.08;
  const ground = ctx.createLinearGradient(0, groundTop, 0, h);
  ground.addColorStop(0, '#3f6b3a');
  ground.addColorStop(1, '#1f3d1c');
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.moveTo(0, h);
  const gy = ridge(rand, groundTop, h * 0.025, w);
  for (let x = 0; x <= w; x += Math.max(2, w / 200)) ctx.lineTo(x, gy(x));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  // Path narrowing into the distance.
  ctx.fillStyle = 'rgba(214,190,150,0.85)';
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h);
  ctx.quadraticCurveTo(w * 0.5, h * 0.84, w * 0.53, groundTop + h * 0.01);
  ctx.lineTo(w * 0.545, groundTop + h * 0.01);
  ctx.quadraticCurveTo(w * 0.6, h * 0.86, w * 0.62, h);
  ctx.closePath();
  ctx.fill();
  // Pine trees, smaller and hazier with distance.
  const trees = [
    { x: 0.1, y: 0.97, s: 0.3 }, { x: 0.2, y: 0.9, s: 0.2 }, { x: 0.82, y: 0.99, s: 0.34 },
    { x: 0.72, y: 0.85, s: 0.14 }, { x: 0.9, y: 0.83, s: 0.12 }, { x: 0.35, y: 0.8, s: 0.08 },
  ].sort((a, b) => a.y - b.y);
  for (const t of trees) {
    const th = h * t.s, tx = w * t.x, ty = h * t.y;
    const shade = Math.round(20 + (1 - t.s) * 50);
    ctx.fillStyle = `rgb(${shade - 10},${shade + 25},${shade})`;
    for (let k = 0; k < 3; k++) {
      const top = ty - th + (k * th) / 4.5;
      const half = th * (0.18 + k * 0.07);
      ctx.beginPath();
      ctx.moveTo(tx, top);
      ctx.lineTo(tx - half, top + th * 0.45);
      ctx.lineTo(tx + half, top + th * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#3b2a1e';
    ctx.fillRect(tx - th * 0.025, ty - th * 0.12, th * 0.05, th * 0.12);
  }
  // Film grain for a photographic feel.
  if (w * h <= 2_000_000) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 14;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
}

export const SAMPLES: SampleSpec[] = [
  {
    id: 'logo',
    name: { tr: 'Yıldız logo', en: 'Star logo' },
    fileName: 'sample-star-logo.png',
    width: 768,
    height: 768,
    driverId: 'silhouette-extrude',
    draw: drawLogo,
  },
  {
    id: 'mascot',
    name: { tr: 'Maskot', en: 'Mascot' },
    fileName: 'sample-mascot.png',
    width: 768,
    height: 768,
    driverId: 'silhouette-inflate',
    draw: drawMascot,
  },
  {
    id: 'landscape',
    name: { tr: 'Manzara fotoğrafı', en: 'Landscape photo' },
    fileName: 'sample-landscape.png',
    width: 1024,
    height: 683,
    driverId: 'depth-anything-v2-small',
    draw: drawLandscape,
  },
];

/** Render a sample to a PNG blob (browser only). */
export async function renderSample(spec: SampleSpec): Promise<Blob> {
  const { width: w, height: h } = spec;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      spec.draw(ctx, w, h);
      return canvas.convertToBlob({ type: 'image/png' });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available');
  spec.draw(ctx, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}
