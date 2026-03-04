#!/usr/bin/env node
/**
 * Procedural Pixel Art Generator
 *
 * Generates animated GIFs for UI elements:
 * - axolotl-search.gif: Axolotl chasing a firefly
 * - hunt-river.gif: Axolotl swimming in river
 * - hunt-forest.gif: Axolotl creeping through forest
 * - hunt-beach.gif: Axolotl in tidal pools
 * - hunt-city.gif: Axolotl in urban waterway
 * - hunt-dockyard.gif: Axolotl in harbor water
 * - card-pack.png: Static card pack image
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'packages/frontend/public/ui-elements');
mkdirSync(OUT, { recursive: true });

// ── Canvas helpers ────────────────────────────────────────────────────

class PixelCanvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4); // RGBA
  }

  clear(r = 0, g = 0, b = 0, a = 255) {
    for (let i = 0; i < this.w * this.h; i++) {
      this.data[i * 4] = r;
      this.data[i * 4 + 1] = g;
      this.data[i * 4 + 2] = b;
      this.data[i * 4 + 3] = a;
    }
  }

  setPixel(x, y, r, g, b, a = 255) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a < 255) {
      // Alpha blend
      const srcA = a / 255;
      const dstA = 1 - srcA;
      this.data[i] = Math.round(r * srcA + this.data[i] * dstA);
      this.data[i + 1] = Math.round(g * srcA + this.data[i + 1] * dstA);
      this.data[i + 2] = Math.round(b * srcA + this.data[i + 2] * dstA);
      this.data[i + 3] = Math.min(255, this.data[i + 3] + a);
    } else {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  fillRect(x, y, w, h, r, g, b, a = 255) {
    x = Math.round(x); y = Math.round(y);
    w = Math.round(w); h = Math.round(h);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.setPixel(x + dx, y + dy, r, g, b, a);
      }
    }
  }

  fillCircle(cx, cy, radius, r, g, b, a = 255) {
    cx = Math.round(cx); cy = Math.round(cy);
    radius = Math.round(radius);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius) {
          this.setPixel(cx + dx, cy + dy, r, g, b, a);
        }
      }
    }
  }

  // Draw a line (Bresenham)
  drawLine(x0, y0, x1, y1, r, g, b, a = 255) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      this.setPixel(x0, y0, r, g, b, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  getBuffer() {
    return Buffer.from(this.data.buffer);
  }
}

// ── Color palette ────────────────────────────────────────────────────

const C = {
  // Axolotl colors
  axoBody: [255, 200, 210],
  axoBodyLight: [255, 220, 225],
  axoBelly: [255, 235, 240],
  axoGill: [220, 80, 100],
  axoGillLight: [240, 120, 140],
  axoEye: [20, 20, 30],
  axoEyeShine: [255, 255, 255],
  axoSmile: [180, 80, 100],

  // Environment
  water: [40, 90, 140],
  waterLight: [60, 120, 170],
  waterDark: [25, 60, 100],
  waterShine: [100, 170, 220],

  grass: [40, 100, 40],
  grassLight: [60, 140, 60],
  grassDark: [25, 70, 25],

  sand: [210, 190, 140],
  sandLight: [230, 215, 170],
  sandDark: [180, 160, 110],

  wood: [120, 80, 50],
  woodLight: [150, 110, 70],
  woodDark: [80, 50, 30],

  stone: [100, 100, 110],
  stoneLight: [130, 130, 140],
  stoneDark: [70, 70, 80],

  sky: [15, 20, 40],
  skyLight: [25, 35, 60],

  moon: [240, 235, 200],
  moonGlow: [200, 195, 160],

  firefly: [255, 220, 80],
  fireflyGlow: [255, 200, 50],

  leaf: [50, 120, 50],
  leafDark: [30, 80, 30],

  mushroom: [180, 140, 100],
  mushroomCap: [200, 60, 60],

  cobble: [90, 85, 80],
  cobbleLight: [110, 105, 100],

  lampLight: [255, 240, 180],
  lampPost: [60, 60, 65],

  rope: [160, 130, 80],
  barnacle: [140, 150, 130],

  // UI
  packGreen: [30, 60, 35],
  packGold: [196, 162, 101],
  packGoldLight: [220, 190, 130],
  packDark: [15, 30, 18],
};

// ── Axolotl sprite drawing ─────────────────────────────────────────────

function drawAxolotl(canvas, x, y, frame = 0, facingRight = true, scale = 1) {
  const s = scale;
  const flip = facingRight ? 1 : -1;
  const bobY = Math.sin(frame * 0.5) * 1 * s;

  // Body (oval)
  for (let dy = -3 * s; dy <= 3 * s; dy++) {
    for (let dx = -5 * s; dx <= 5 * s; dx++) {
      const nx = dx / (5 * s);
      const ny = dy / (3 * s);
      if (nx * nx + ny * ny <= 1) {
        const isTop = dy < 0;
        canvas.setPixel(
          x + dx * flip, y + dy + bobY,
          ...(isTop ? C.axoBody : C.axoBelly)
        );
      }
    }
  }

  // Head (rounder, front)
  const headX = x + 6 * s * flip;
  const headY = y - 1 * s + bobY;
  for (let dy = -3 * s; dy <= 2 * s; dy++) {
    for (let dx = -3 * s; dx <= 3 * s; dx++) {
      if (dx * dx + dy * dy <= (3 * s) * (3 * s)) {
        canvas.setPixel(
          headX + dx, headY + dy,
          ...(dy < 0 ? C.axoBodyLight : C.axoBelly)
        );
      }
    }
  }

  // Gills (3 fronds on each side of head)
  const gillWave = Math.sin(frame * 0.8) * s;
  for (let i = 0; i < 3; i++) {
    const angle = (-0.5 + i * 0.5) + gillWave * 0.1;
    const gLen = (3 + i % 2) * s;
    const gx = headX + Math.cos(angle) * gLen * flip;
    const gy = headY - 3 * s + Math.sin(angle) * gLen;
    canvas.drawLine(
      Math.round(headX + 1 * flip), Math.round(headY - 2 * s),
      Math.round(gx), Math.round(gy),
      ...C.axoGill
    );
    canvas.setPixel(Math.round(gx), Math.round(gy), ...C.axoGillLight);
  }
  // Other side gills
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI + 0.5 - i * 0.5) + gillWave * 0.1;
    const gLen = (3 + i % 2) * s;
    const gx = headX + Math.cos(angle) * gLen * flip;
    const gy = headY - 3 * s + Math.sin(angle) * gLen;
    canvas.drawLine(
      Math.round(headX - 1 * flip), Math.round(headY - 2 * s),
      Math.round(gx), Math.round(gy),
      ...C.axoGill
    );
    canvas.setPixel(Math.round(gx), Math.round(gy), ...C.axoGillLight);
  }

  // Eyes
  const eyeX = Math.round(headX + 1 * s * flip);
  const eyeY = Math.round(headY - 1 * s);
  canvas.fillRect(eyeX - 1, eyeY - 1, 2, 2, ...C.axoEye);
  canvas.setPixel(eyeX, eyeY - 1, ...C.axoEyeShine);

  // Smile
  canvas.setPixel(headX + 2 * flip, headY + 1, ...C.axoSmile);

  // Legs (4 little stubs, animated)
  const legPhase = frame * 0.6;
  const legs = [
    { ox: -3 * s, oy: 3 * s, phase: 0 },
    { ox: -1 * s, oy: 3 * s, phase: Math.PI },
    { ox: 2 * s, oy: 3 * s, phase: Math.PI / 2 },
    { ox: 4 * s, oy: 3 * s, phase: Math.PI * 1.5 },
  ];
  for (const leg of legs) {
    const lx = Math.round(x + leg.ox * flip);
    const ly = Math.round(y + leg.oy + bobY);
    const legOff = Math.sin(legPhase + leg.phase) * s;
    canvas.fillRect(lx, ly, s, 2 * s + Math.round(legOff), ...C.axoBody);
  }

  // Tail
  const tailWave = Math.sin(frame * 0.4) * 2 * s;
  const tailX = x - 6 * s * flip;
  canvas.drawLine(
    Math.round(x - 4 * s * flip), Math.round(y + bobY),
    Math.round(tailX), Math.round(y + tailWave + bobY),
    ...C.axoBody
  );
  canvas.drawLine(
    Math.round(tailX), Math.round(y + tailWave + bobY),
    Math.round(tailX - 2 * s * flip), Math.round(y + tailWave + s + bobY),
    ...C.axoBodyLight
  );
}

// ── Firefly ──────────────────────────────────────────────────────────

function drawFirefly(canvas, x, y, frame) {
  const pulse = 0.5 + 0.5 * Math.sin(frame * 1.2);
  const glowR = 3 + Math.round(pulse * 2);

  // Glow
  for (let dy = -glowR; dy <= glowR; dy++) {
    for (let dx = -glowR; dx <= glowR; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= glowR) {
        const alpha = Math.round((1 - dist / glowR) * 80 * pulse);
        canvas.setPixel(Math.round(x + dx), Math.round(y + dy), ...C.fireflyGlow, alpha);
      }
    }
  }

  // Core
  canvas.setPixel(x, y, ...C.firefly);
  canvas.setPixel(x + 1, y, ...C.firefly);
  canvas.setPixel(x, y - 1, 255, 255, 200);

  // Wings (tiny, flicker)
  if (frame % 2 === 0) {
    canvas.setPixel(x - 1, y - 1, 200, 200, 180, 150);
    canvas.setPixel(x + 2, y - 1, 200, 200, 180, 150);
  }
}

// ── Stars ──────────────────────────────────────────────────────────

function drawStars(canvas, frame, seed = 42) {
  let rng = seed;
  const next = () => { rng = (rng * 16807 + 0) % 2147483647; return rng / 2147483647; };

  for (let i = 0; i < 30; i++) {
    const sx = Math.round(next() * canvas.w);
    const sy = Math.round(next() * canvas.h * 0.4);
    const twinkle = Math.sin(frame * 0.3 + i) * 0.3 + 0.7;
    const bright = Math.round(180 * twinkle);
    canvas.setPixel(sx, sy, bright, bright, bright + 20);
  }
}

// ── Moon ────────────────────────────────────────────────────────────

function drawMoon(canvas, x, y, radius = 6) {
  // Glow
  for (let dy = -radius * 2; dy <= radius * 2; dy++) {
    for (let dx = -radius * 2; dx <= radius * 2; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius * 2 && dist > radius) {
        const alpha = Math.round((1 - (dist - radius) / radius) * 40);
        canvas.setPixel(x + dx, y + dy, ...C.moonGlow, alpha);
      }
    }
  }
  canvas.fillCircle(x, y, radius, ...C.moon);
  // Craters
  canvas.setPixel(x - 2, y - 1, ...C.moonGlow);
  canvas.setPixel(x + 1, y + 1, ...C.moonGlow);
}

// ── Water surface ────────────────────────────────────────────────────

function drawWater(canvas, startY, frame, colors = null) {
  const wc = colors || { base: C.water, light: C.waterLight, dark: C.waterDark, shine: C.waterShine };

  for (let y = startY; y < canvas.h; y++) {
    const depth = (y - startY) / (canvas.h - startY);
    for (let x = 0; x < canvas.w; x++) {
      const wave = Math.sin(x * 0.15 + frame * 0.3 + y * 0.1) * 0.3;
      const t = depth + wave * 0.1;
      const r = Math.round(wc.base[0] * (1 - t) + wc.dark[0] * t);
      const g = Math.round(wc.base[1] * (1 - t) + wc.dark[1] * t);
      const b = Math.round(wc.base[2] * (1 - t) + wc.dark[2] * t);
      canvas.setPixel(x, y, r, g, b);
    }
  }

  // Surface sparkles
  for (let x = 0; x < canvas.w; x += 3) {
    const waveY = startY + Math.round(Math.sin(x * 0.2 + frame * 0.4) * 1.5);
    canvas.setPixel(x, waveY, ...wc.shine, 150);
    if ((x + frame * 2) % 7 === 0) {
      canvas.setPixel(x, waveY - 1, ...wc.shine, 100);
    }
  }
}

// ── Reeds / Cattails ────────────────────────────────────────────────

function drawReeds(canvas, positions, frame) {
  for (const [rx, ry, height] of positions) {
    const sway = Math.sin(frame * 0.2 + rx * 0.3) * 1.5;
    // Stem
    for (let i = 0; i < height; i++) {
      const swayOff = Math.round(sway * (i / height));
      canvas.setPixel(rx + swayOff, ry - i, 50, 90, 40);
    }
    // Cattail head
    const topX = rx + Math.round(sway);
    canvas.fillRect(topX - 1, ry - height - 2, 2, 4, 100, 60, 30);
  }
}

// ── Trees ────────────────────────────────────────────────────────────

function drawTree(canvas, x, y, size = 1) {
  // Trunk
  canvas.fillRect(x - 1, y - 4 * size, 3, 6 * size, ...C.woodDark);
  // Canopy layers
  for (let layer = 0; layer < 3; layer++) {
    const ly = y - 6 * size - layer * 3 * size;
    const lw = (4 - layer) * size;
    for (let dy = 0; dy < 3 * size; dy++) {
      for (let dx = -lw; dx <= lw; dx++) {
        if (Math.random() > 0.15) {
          const shade = Math.random() > 0.5 ? C.leaf : C.leafDark;
          canvas.setPixel(x + dx, ly + dy, ...shade);
        }
      }
    }
  }
}

// ── Mushrooms ────────────────────────────────────────────────────────

function drawMushroom(canvas, x, y, color = C.mushroomCap) {
  // Stem
  canvas.fillRect(x, y - 2, 2, 3, ...C.mushroom);
  // Cap
  canvas.fillRect(x - 2, y - 4, 6, 2, ...color);
  canvas.fillRect(x - 1, y - 5, 4, 1, ...color);
  // Spots
  canvas.setPixel(x, y - 4, 255, 255, 255, 180);
  canvas.setPixel(x + 2, y - 5, 255, 255, 255, 150);
}

// ── Lily pads ────────────────────────────────────────────────────────

function drawLilyPad(canvas, x, y, frame) {
  const bob = Math.sin(frame * 0.2 + x) * 0.5;
  const py = Math.round(y + bob);
  canvas.fillCircle(x, py, 3, 40, 120, 40);
  canvas.setPixel(x + 1, py, 60, 140, 60);
  // Notch
  canvas.setPixel(x + 2, py, ...C.waterLight);
}

// ── Stones ──────────────────────────────────────────────────────────

function drawStone(canvas, x, y, size = 2) {
  for (let dy = -size; dy <= size; dy++) {
    for (let dx = -size - 1; dx <= size + 1; dx++) {
      const nx = dx / (size + 1);
      const ny = dy / size;
      if (nx * nx + ny * ny <= 1) {
        const shade = dy < 0 ? C.stoneLight : C.stoneDark;
        canvas.setPixel(x + dx, y + dy, ...shade);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// SCENE GENERATORS
// ══════════════════════════════════════════════════════════════════════

function generateSearchScene(numFrames = 12) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(...C.sky);

    drawStars(c, f);
    drawMoon(c, 130, 12, 5);

    // Ground
    drawWater(c, 58, f);

    // Lily pads
    drawLilyPad(c, 20, 60, f);
    drawLilyPad(c, 55, 63, f);
    drawLilyPad(c, 100, 61, f);
    drawLilyPad(c, 140, 64, f);

    // Reeds
    drawReeds(c, [[5, 58, 18], [12, 58, 14], [148, 58, 16], [155, 58, 12]], f);

    // Axolotl walking across scene
    const axoX = 30 + Math.sin(f * 0.3) * 10 + (f / numFrames) * 20;
    const axoY = 52 + Math.sin(f * 0.5) * 2;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Firefly ahead of axolotl
    const flyX = axoX + 30 + Math.sin(f * 0.7) * 8;
    const flyY = 40 + Math.sin(f * 1.1 + 1) * 6;
    drawFirefly(c, Math.round(flyX), Math.round(flyY), f);

    // Extra fireflies in background
    drawFirefly(c, 15 + Math.round(Math.sin(f * 0.4) * 3), 35 + Math.round(Math.cos(f * 0.3) * 4), f + 3);
    drawFirefly(c, 120 + Math.round(Math.sin(f * 0.5 + 2) * 5), 30 + Math.round(Math.sin(f * 0.6) * 3), f + 7);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateRiverScene(numFrames = 10) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(...C.sky);

    drawStars(c, f, 100);
    drawMoon(c, 120, 14, 6);

    // Distant treeline
    for (let x = 0; x < W; x++) {
      const h = 30 + Math.sin(x * 0.08) * 5 + Math.sin(x * 0.15 + 1) * 3;
      for (let y = Math.round(h); y < 45; y++) {
        c.setPixel(x, y, 20, 50 + Math.round(Math.sin(x * 0.3) * 10), 25);
      }
    }

    // River banks
    for (let x = 0; x < W; x++) {
      const bankTop = 42 + Math.sin(x * 0.05) * 3;
      c.fillRect(x, Math.round(bankTop), 1, 3, ...C.grassDark);
    }

    // River water
    drawWater(c, 45, f);

    // Stones in river
    drawStone(c, 30, 55, 2);
    drawStone(c, 90, 60, 3);
    drawStone(c, 130, 52, 2);

    // Lily pads
    drawLilyPad(c, 50, 50, f);
    drawLilyPad(c, 110, 55, f);

    // Reeds on banks
    drawReeds(c, [[8, 45, 14], [15, 44, 10], [145, 45, 12], [152, 44, 15]], f);

    // Axolotl swimming
    const axoX = 65 + Math.sin(f * 0.4) * 12;
    const axoY = 53 + Math.sin(f * 0.6) * 2;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Bug above water
    const bugX = axoX + 20 + Math.sin(f * 0.8) * 5;
    const bugY = 42 + Math.sin(f * 1.2) * 3;
    drawFirefly(c, Math.round(bugX), Math.round(bugY), f);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateForestScene(numFrames = 10) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(8, 15, 8);

    // Dark forest canopy top
    for (let x = 0; x < W; x++) {
      const h = 5 + Math.sin(x * 0.1) * 3;
      for (let y = 0; y < h; y++) {
        c.setPixel(x, y, 15, 35 + Math.round(Math.random() * 10), 15);
      }
    }

    // Tree trunks (background)
    drawTree(c, 15, 50, 2);
    drawTree(c, 50, 45, 3);
    drawTree(c, 95, 48, 2);
    drawTree(c, 135, 42, 3);

    // Moonlight rays
    for (let i = 0; i < 3; i++) {
      const rayX = 40 + i * 40;
      for (let y = 5; y < 70; y++) {
        const spread = (y - 5) * 0.15;
        for (let dx = Math.round(-spread); dx <= Math.round(spread); dx++) {
          c.setPixel(rayX + dx, y, 100, 180, 100, 8);
        }
      }
    }

    // Forest floor
    for (let x = 0; x < W; x++) {
      const floorY = 68 + Math.round(Math.sin(x * 0.2) * 2);
      for (let y = floorY; y < H; y++) {
        const shade = Math.random() > 0.5;
        c.setPixel(x, y, shade ? 30 : 22, shade ? 60 : 45, shade ? 20 : 15);
      }
    }

    // Mushrooms
    drawMushroom(c, 25, 72);
    drawMushroom(c, 70, 70, [180, 140, 60]);
    drawMushroom(c, 110, 73, [100, 60, 160]);
    drawMushroom(c, 140, 71);

    // Bioluminescent fungi on trees
    const glow1 = 0.5 + 0.5 * Math.sin(f * 0.5);
    c.fillCircle(17, 40, 2, 100, 200, 100, Math.round(glow1 * 100));
    c.fillCircle(52, 35, 2, 80, 180, 220, Math.round(glow1 * 80));
    c.fillCircle(97, 38, 2, 100, 200, 100, Math.round(glow1 * 90));

    // Fallen leaves
    for (let i = 0; i < 15; i++) {
      const lx = (i * 11 + 3) % W;
      const ly = 66 + (i * 7) % 8;
      c.setPixel(lx, ly, 120 + (i * 20) % 60, 80 + (i * 15) % 40, 20);
    }

    // Axolotl creeping
    const axoX = 60 + Math.sin(f * 0.35) * 8;
    const axoY = 64 + Math.sin(f * 0.5) * 1;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Glowing beetles
    drawFirefly(c, 85 + Math.round(Math.sin(f * 0.6) * 4), 58 + Math.round(Math.cos(f * 0.8) * 3), f);
    drawFirefly(c, 30 + Math.round(Math.cos(f * 0.4) * 3), 55 + Math.round(Math.sin(f * 0.5) * 4), f + 5);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateBeachScene(numFrames = 10) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(10, 15, 35);

    drawStars(c, f, 200);
    drawMoon(c, 30, 15, 7);

    // Ocean horizon
    for (let x = 0; x < W; x++) {
      for (let y = 35; y < 55; y++) {
        const wave = Math.sin(x * 0.1 + f * 0.3 + y * 0.1);
        const t = (y - 35) / 20;
        c.setPixel(x, y,
          Math.round(20 + t * 20 + wave * 5),
          Math.round(40 + t * 30 + wave * 8),
          Math.round(80 + t * 40 + wave * 10)
        );
      }
    }

    // Waves crashing on shore
    const waveOffset = f * 0.4;
    for (let x = 0; x < W; x++) {
      const waveY = 54 + Math.round(Math.sin(x * 0.08 + waveOffset) * 2);
      c.setPixel(x, waveY, 180, 200, 220);
      c.setPixel(x, waveY + 1, 150, 180, 200, 150);
    }

    // Sand beach
    for (let x = 0; x < W; x++) {
      const sandStart = 56 + Math.round(Math.sin(x * 0.05) * 1);
      for (let y = sandStart; y < H; y++) {
        const shade = ((x + y) * 7) % 3 === 0;
        c.setPixel(x, y, ...(shade ? C.sandLight : C.sand));
      }
    }

    // Tidal pools
    for (const [px, py, r] of [[40, 65, 6], [110, 68, 5], [75, 72, 4]]) {
      for (let dy = -r; dy <= r / 2; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if ((dx * dx) / (r * r) + (dy * dy) / ((r / 2) * (r / 2)) <= 1) {
            const shimmer = Math.sin(f * 0.5 + dx + dy) * 10;
            c.setPixel(px + dx, py + dy,
              40 + Math.round(shimmer), 80 + Math.round(shimmer), 120 + Math.round(shimmer));
          }
        }
      }
    }

    // Shells
    for (const [sx, sy] of [[55, 62], [95, 65], [130, 60], [25, 70]]) {
      c.setPixel(sx, sy, 220, 200, 180);
      c.setPixel(sx + 1, sy, 200, 180, 160);
      c.setPixel(sx, sy + 1, 240, 220, 200);
    }

    // Axolotl in tidal pool
    const axoX = 40 + Math.sin(f * 0.3) * 4;
    const axoY = 62 + Math.sin(f * 0.5) * 1;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Glowing crabs / insects
    drawFirefly(c, 50 + Math.round(Math.sin(f * 0.7) * 3), 60 + Math.round(Math.cos(f * 0.9) * 2), f);
    drawFirefly(c, 115 + Math.round(Math.cos(f * 0.5) * 4), 64 + Math.round(Math.sin(f * 0.6) * 2), f + 4);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateCityScene(numFrames = 10) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(15, 12, 20);

    // City skyline silhouette
    const buildings = [
      [0, 15, 20, 35], [20, 10, 15, 40], [35, 20, 18, 30],
      [53, 8, 12, 42], [65, 25, 20, 25], [85, 12, 14, 38],
      [99, 18, 16, 32], [115, 5, 10, 45], [125, 22, 20, 28],
      [145, 15, 15, 35],
    ];
    for (const [bx, by, bw, bh] of buildings) {
      c.fillRect(bx, by, bw, bh + 10, 25, 22, 30);
      // Windows (lit randomly)
      for (let wy = by + 3; wy < by + bh; wy += 4) {
        for (let wx = bx + 2; wx < bx + bw - 2; wx += 4) {
          const lit = ((wx * 7 + wy * 13 + f) % 5) < 2;
          if (lit) {
            c.fillRect(wx, wy, 2, 2, 255, 240, 150, 120);
          }
        }
      }
    }

    // Street level
    for (let x = 0; x < W; x++) {
      for (let y = 55; y < H; y++) {
        const cobble = ((x + y * 3) % 5 === 0);
        c.setPixel(x, y, ...(cobble ? C.cobbleLight : C.cobble));
      }
    }

    // Puddles with reflections
    for (const [px, py, pw] of [[20, 62, 18], [80, 65, 14], [130, 60, 12]]) {
      for (let dx = 0; dx < pw; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const shimmer = Math.sin(f * 0.4 + dx * 0.3) * 15;
          c.setPixel(px + dx, py + dy,
            30 + Math.round(shimmer), 30 + Math.round(shimmer), 50 + Math.round(shimmer));
        }
      }
    }

    // Streetlamp
    const lampX = 70;
    c.fillRect(lampX, 35, 2, 22, ...C.lampPost);
    c.fillRect(lampX - 2, 33, 6, 3, ...C.lampPost);
    // Lamp glow
    const lampGlow = 0.7 + 0.3 * Math.sin(f * 0.5);
    for (let dy = -8; dy <= 12; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10) {
          const alpha = Math.round((1 - dist / 10) * 50 * lampGlow);
          c.setPixel(lampX + dx, 34 + dy, ...C.lampLight, alpha);
        }
      }
    }

    // Steam from grate
    if (f % 3 < 2) {
      for (let i = 0; i < 4; i++) {
        const sx = 40 + Math.round(Math.sin(f * 0.3 + i) * 2);
        const sy = 55 - i * 3 - Math.round(f * 0.5 % 5);
        c.setPixel(sx, sy, 180, 180, 190, 40);
        c.setPixel(sx + 1, sy - 1, 180, 180, 190, 25);
      }
    }

    // Axolotl in puddle
    const axoX = 22 + Math.sin(f * 0.35) * 5;
    const axoY = 60 + Math.sin(f * 0.5) * 1;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Moths near lamp
    drawFirefly(c, lampX + Math.round(Math.sin(f * 1.0) * 6), 30 + Math.round(Math.cos(f * 0.8) * 4), f);
    drawFirefly(c, lampX + Math.round(Math.cos(f * 0.7 + 2) * 5), 32 + Math.round(Math.sin(f * 0.9 + 1) * 3), f + 3);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateDockyardScene(numFrames = 10) {
  const W = 160, H = 90;
  const frames = [];

  for (let f = 0; f < numFrames; f++) {
    const c = new PixelCanvas(W, H);
    c.clear(10, 12, 22);

    drawStars(c, f, 300);

    // Ship hull silhouette (distant)
    c.fillRect(90, 15, 50, 15, 30, 25, 20);
    c.fillRect(95, 10, 3, 20, ...C.woodDark);

    // Dock planks
    for (let x = 0; x < 55; x++) {
      for (let y = 30; y < 42; y++) {
        const plank = ((x + y * 2) % 8 < 7);
        c.setPixel(x, y, ...(plank ? C.wood : C.woodDark));
      }
      // Plank gaps
      if (x % 8 === 0) {
        for (let y = 30; y < 42; y++) {
          c.setPixel(x, y, 5, 8, 15);
        }
      }
    }

    // Pilings
    for (const px of [55, 65, 75]) {
      c.fillRect(px - 1, 25, 4, 50, ...C.woodDark);
      c.fillRect(px, 26, 2, 48, ...C.wood);
      // Barnacles
      c.setPixel(px, 45, ...C.barnacle);
      c.setPixel(px + 1, 50, ...C.barnacle);
      c.setPixel(px - 1, 48, ...C.barnacle);
    }

    // Rope
    for (let i = 0; i < 12; i++) {
      const rx = 55 + i;
      const ry = 28 + Math.round(Math.sin(i * 0.5 + f * 0.2) * 2);
      c.setPixel(rx, ry, ...C.rope);
    }

    // Dark harbor water
    const harborWater = {
      base: [20, 35, 55], light: [30, 50, 70],
      dark: [10, 20, 35], shine: [50, 80, 110]
    };
    drawWater(c, 42, f, harborWater);

    // Dock lanterns
    for (const [lx, ly] of [[10, 28], [45, 28]]) {
      c.fillRect(lx, ly, 3, 3, 200, 160, 80);
      const glow = 0.6 + 0.4 * Math.sin(f * 0.6 + lx);
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 5) {
            c.setPixel(lx + 1 + dx, ly + 1 + dy, 200, 160, 80, Math.round((1 - dist / 5) * 40 * glow));
          }
        }
      }
    }

    // Axolotl diving into water
    const axoX = 50 + Math.sin(f * 0.3) * 6;
    const axoY = 47 + Math.sin(f * 0.5) * 3;
    drawAxolotl(c, Math.round(axoX), Math.round(axoY), f, true, 2);

    // Deep water bug
    drawFirefly(c, 85 + Math.round(Math.sin(f * 0.5) * 8), 55 + Math.round(Math.cos(f * 0.7) * 5), f);

    frames.push(c);
  }
  return { frames, w: W, h: H };
}

function generateCardPack() {
  const W = 80, H = 100;
  const c = new PixelCanvas(W, H);
  c.clear(0, 0, 0, 0);

  // Pack body
  const padX = 8, padY = 6;
  const pw = W - padX * 2, ph = H - padY * 2;

  // Shadow
  c.fillRect(padX + 2, padY + 2, pw, ph, 0, 0, 0, 80);

  // Main pack
  c.fillRect(padX, padY, pw, ph, ...C.packGreen);

  // Border
  for (let x = padX; x < padX + pw; x++) {
    c.setPixel(x, padY, ...C.packGold);
    c.setPixel(x, padY + 1, ...C.packGoldLight, 80);
    c.setPixel(x, padY + ph - 1, ...C.packGold);
  }
  for (let y = padY; y < padY + ph; y++) {
    c.setPixel(padX, y, ...C.packGold);
    c.setPixel(padX + 1, y, ...C.packGoldLight, 80);
    c.setPixel(padX + pw - 1, y, ...C.packGold);
  }

  // Inner border
  c.fillRect(padX + 4, padY + 4, pw - 8, ph - 8, ...C.packDark);
  c.fillRect(padX + 6, padY + 6, pw - 12, ph - 12, ...C.packGreen);

  // Inner gold border
  for (let x = padX + 4; x < padX + pw - 4; x++) {
    c.setPixel(x, padY + 4, ...C.packGold, 180);
    c.setPixel(x, padY + ph - 5, ...C.packGold, 180);
  }
  for (let y = padY + 4; y < padY + ph - 4; y++) {
    c.setPixel(padX + 4, y, ...C.packGold, 180);
    c.setPixel(padX + pw - 5, y, ...C.packGold, 180);
  }

  // Axolotl emblem in center (simplified)
  const cx = W / 2, cy = H / 2 - 4;
  // Body
  for (let dy = -4; dy <= 3; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      if ((dx * dx) / 36 + (dy * dy) / 16 <= 1) {
        c.setPixel(Math.round(cx + dx), Math.round(cy + dy), ...C.packGold, 200);
      }
    }
  }
  // Head
  c.fillCircle(Math.round(cx + 6), Math.round(cy - 1), 3, ...C.packGoldLight, 200);
  // Gills
  for (let i = 0; i < 3; i++) {
    const angle = -0.5 + i * 0.5;
    const gx = Math.round(cx + 7 + Math.cos(angle) * 4);
    const gy = Math.round(cy - 4 + Math.sin(angle) * 4);
    c.drawLine(Math.round(cx + 7), Math.round(cy - 3), gx, gy, ...C.packGold, 180);
  }
  // Eye
  c.setPixel(Math.round(cx + 7), Math.round(cy - 1), ...C.packDark);
  // Tail
  c.drawLine(Math.round(cx - 6), Math.round(cy), Math.round(cx - 10), Math.round(cy + 2), ...C.packGold, 180);

  // "CARDS" text pixel art at bottom
  const textY = H - 16;
  // Simple 3x5 pixel font for "CARDS"
  const letters = {
    C: [[1,0],[0,1],[0,2],[0,3],[1,4]],
    A: [[1,0],[0,1],[2,1],[0,2],[1,2],[2,2],[0,3],[2,3],[0,4],[2,4]],
    R: [[0,0],[1,0],[0,1],[2,1],[0,2],[1,2],[0,3],[2,3],[0,4],[2,4]],
    D: [[0,0],[1,0],[0,1],[2,1],[0,2],[2,2],[0,3],[2,3],[0,4],[1,4]],
    S: [[1,0],[2,0],[0,1],[1,2],[2,3],[0,4],[1,4]],
  };
  const word = 'CARDS';
  let tx = Math.round(cx - (word.length * 4) / 2);
  for (const ch of word) {
    const pts = letters[ch] || [];
    for (const [dx, dy] of pts) {
      c.setPixel(tx + dx, textY + dy, ...C.packGold, 220);
    }
    tx += 4;
  }

  return c;
}

// ── Image encoding ──────────────────────────────────────────────────

function encodePng(canvas, scale) {
  const { w, h, data } = canvas;
  const sw = w * scale, sh = h * scale;
  const png = new PNG({ width: sw, height: sh });
  for (let sy = 0; sy < sh; sy++) {
    const srcY = Math.floor(sy / scale);
    for (let sx = 0; sx < sw; sx++) {
      const srcX = Math.floor(sx / scale);
      const si = (srcY * w + srcX) * 4;
      const di = (sy * sw + sx) * 4;
      png.data[di] = data[si];
      png.data[di + 1] = data[si + 1];
      png.data[di + 2] = data[si + 2];
      png.data[di + 3] = data[si + 3];
    }
  }
  return PNG.sync.write(png);
}

function encodeSpriteSheet(scene, scale) {
  const { frames, w, h } = scene;
  const n = frames.length;
  const totalW = w * n;
  // Build at native res, then scale
  const png = new PNG({ width: totalW * scale, height: h * scale });
  const sw = totalW * scale, sh = h * scale;
  for (let f = 0; f < n; f++) {
    const src = frames[f].data;
    for (let sy = 0; sy < sh; sy++) {
      const srcY = Math.floor(sy / scale);
      for (let sx = 0; sx < w * scale; sx++) {
        const srcX = Math.floor(sx / scale);
        const si = (srcY * w + srcX) * 4;
        const outX = f * w * scale + sx;
        const di = (sy * sw + outX) * 4;
        png.data[di] = src[si];
        png.data[di + 1] = src[si + 1];
        png.data[di + 2] = src[si + 2];
        png.data[di + 3] = src[si + 3];
      }
    }
  }
  return PNG.sync.write(png);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating pixel art assets...\n');

  // Card pack (static PNG)
  console.log('  card-pack.png');
  const packCanvas = generateCardPack();
  const packData = encodePng(packCanvas, 3);
  writeFileSync(path.join(OUT, 'card-pack.png'), packData);

  const SCALE = 2;
  // Sprite sheets (horizontal strip of frames)
  const scenes = [
    { name: 'axolotl-search', gen: generateSearchScene, frames: 6 },
    { name: 'hunt-river', gen: generateRiverScene, frames: 6 },
    { name: 'hunt-forest', gen: generateForestScene, frames: 6 },
    { name: 'hunt-beach', gen: generateBeachScene, frames: 6 },
    { name: 'hunt-city', gen: generateCityScene, frames: 6 },
    { name: 'hunt-dockyard', gen: generateDockyardScene, frames: 6 },
  ];

  for (const { name, gen, frames } of scenes) {
    console.log(`  ${name}.png (${frames} frames sprite sheet)`);
    const scene = gen(frames);
    const data = encodeSpriteSheet(scene, SCALE);
    writeFileSync(path.join(OUT, `${name}.png`), data);
    console.log(`    -> ${(data.length / 1024).toFixed(0)} KB (${scene.w * SCALE}x${scene.h * SCALE} per frame)`);
  }

  // Write a manifest with frame counts for CSS
  const manifest = {};
  for (const { name, frames } of scenes) {
    manifest[name] = { frames, frameWidth: 160 * SCALE, frameHeight: 90 * SCALE };
  }
  writeFileSync(
    path.join(OUT, 'sprite-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log('  sprite-manifest.json');

  console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
