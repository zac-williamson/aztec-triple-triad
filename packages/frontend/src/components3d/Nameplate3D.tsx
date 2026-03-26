import { useRef, useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CanvasTexture, SRGBColorSpace } from 'three';

interface Nameplate3DProps {
  name: string;
  cardImageSrc: string;
  position: [number, number, number];
  /** Uniform mesh scale — use to compensate for depth so both signs appear the same size */
  meshScale?: number;
  score?: number;
}

// Canvas dimensions — extended right to fit the score circle
const W = 660;
// Canvas is taller to accommodate the enlarged oval (OVL_RY=87 → min height 174 + padding)
const H = 192;

// Plane geometry size in world units
export const NAMEPLATE_W = 1.55;
export const NAMEPLATE_H = NAMEPLATE_W * H / W; // ≈ 0.45

// Oval sign geometry
const OVL_CX = 72;
const OVL_CY = H / 2;
const OVL_RX = 66;
const OVL_RY = 87; // 58 * 1.5

// Plank board geometry (right panel, shorter than oval — unchanged dimensions, re-centred vertically)
const BOARD_X = 128;
const BOARD_RIGHT = 506;
const BOARD_W = BOARD_RIGHT - BOARD_X;
const BOARD_H = 84; // unchanged
const BOARD_TOP = Math.round((H - BOARD_H) / 2);
const BOARD_BOT = BOARD_TOP + BOARD_H;
const PLANK_COUNT = 3;
const PLANK_GAP = 3;
const PLANK_H = (BOARD_H - PLANK_GAP * (PLANK_COUNT - 1)) / PLANK_COUNT;

function woodGradientV(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  light: string, mid: string, dark: string,
) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, light);
  g.addColorStop(0.4, mid);
  g.addColorStop(1, dark);
  return g;
}

function drawGrain(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, seed: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = 0; i < 14; i++) {
    const gy = y + (i / 14) * h;
    const alpha = (i % 3 === 0) ? 0.10 : 0.04;
    ctx.beginPath();
    ctx.moveTo(x, gy);
    for (let px = 0; px <= w; px += 6) {
      ctx.lineTo(x + px, gy + Math.sin((px + seed + i * 31) * 0.04) * 1.4);
    }
    ctx.strokeStyle = `rgba(40,18,4,${alpha})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.restore();
}

// Score circle geometry (right of plank board)
const SCORE_CX = 614;
const SCORE_CY = H / 2;
const SCORE_R = 52;

function buildTexture(
  name: string,
  portrait: HTMLImageElement | null,
  score: number | undefined,
  prev: CanvasTexture | null,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // ── Drop shadows ──────────────────────────────────────────────────────────
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 4;

  // ── Plank board ───────────────────────────────────────────────────────────
  for (let p = 0; p < PLANK_COUNT; p++) {
    const py = BOARD_TOP + p * (PLANK_H + PLANK_GAP);
    const hue = p % 2 === 0 ? '#C8924E' : '#BE8A46';
    ctx.fillStyle = woodGradientV(ctx, BOARD_X, py, BOARD_W, PLANK_H,
      p === 0 ? '#D4A060' : hue, hue, '#9A6830');
    ctx.fillRect(BOARD_X, py, BOARD_W, PLANK_H);
    drawGrain(ctx, BOARD_X, py, BOARD_W, PLANK_H, p * 113);

    const sh = ctx.createLinearGradient(BOARD_X, py, BOARD_X, py + PLANK_H * 0.35);
    sh.addColorStop(0, 'rgba(255,225,150,0.18)');
    sh.addColorStop(1, 'rgba(255,225,150,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(BOARD_X, py, BOARD_W, PLANK_H * 0.35);

    const ds = ctx.createLinearGradient(BOARD_X, py + PLANK_H * 0.6, BOARD_X, py + PLANK_H);
    ds.addColorStop(0, 'rgba(0,0,0,0)');
    ds.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = ds;
    ctx.fillRect(BOARD_X, py + PLANK_H * 0.6, BOARD_W, PLANK_H * 0.4);

    ctx.strokeStyle = 'rgba(35,14,3,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(BOARD_X + 0.5, py + 0.5, BOARD_W - 1, PLANK_H - 1);
  }

  ctx.shadowColor = 'transparent';

  // Plank gaps
  for (let p = 0; p < PLANK_COUNT - 1; p++) {
    const gy = BOARD_TOP + (p + 1) * (PLANK_H + PLANK_GAP) - PLANK_GAP;
    ctx.fillStyle = '#1e0c02';
    ctx.fillRect(BOARD_X, gy, BOARD_W, PLANK_GAP);
  }

  // Board edge shadows
  const le = ctx.createLinearGradient(BOARD_X, 0, BOARD_X + 14, 0);
  le.addColorStop(0, 'rgba(0,0,0,0.3)'); le.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = le;
  ctx.fillRect(BOARD_X, BOARD_TOP, 14, BOARD_H);

  const re = ctx.createLinearGradient(BOARD_RIGHT - 14, 0, BOARD_RIGHT, 0);
  re.addColorStop(0, 'rgba(0,0,0,0)'); re.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = re;
  ctx.fillRect(BOARD_RIGHT - 14, BOARD_TOP, 14, BOARD_H);

  // ── Wooden oval sign ─────────────────────────────────────────────────────
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 5;

  const og = ctx.createRadialGradient(OVL_CX - 10, OVL_CY - 18, 8, OVL_CX, OVL_CY, OVL_RX * 1.1);
  og.addColorStop(0, '#C8904A');
  og.addColorStop(0.5, '#A87030');
  og.addColorStop(1, '#7A4A18');
  ctx.beginPath();
  ctx.ellipse(OVL_CX, OVL_CY, OVL_RX, OVL_RY, 0, 0, Math.PI * 2);
  ctx.fillStyle = og;
  ctx.fill();

  ctx.shadowColor = 'transparent';

  drawGrain(ctx, OVL_CX - OVL_RX, OVL_CY - OVL_RY, OVL_RX * 2, OVL_RY * 2, 77);

  ctx.beginPath();
  ctx.ellipse(OVL_CX, OVL_CY, OVL_RX, OVL_RY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(30,12,3,0.9)';
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(OVL_CX, OVL_CY, OVL_RX - 4, OVL_RY - 4, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(210,175,95,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── Portrait ──────────────────────────────────────────────────────────────
  const PRX = OVL_RX - 8;
  const PRY = OVL_RY - 8;
  if (portrait) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(OVL_CX, OVL_CY, PRX, PRY, 0, 0, Math.PI * 2);
    ctx.clip();
    const aspect = portrait.naturalWidth / portrait.naturalHeight;
    const dh = PRY * 2 + 6;
    const dw = dh * aspect;
    ctx.drawImage(portrait, OVL_CX - dw / 2, OVL_CY - dh / 2, dw, dh);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.ellipse(OVL_CX, OVL_CY, PRX, PRY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(30,12,3,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── Nails ─────────────────────────────────────────────────────────────────
  const drawNail = (nx: number, ny: number) => {
    const ng = ctx.createRadialGradient(nx - 1.5, ny - 1.5, 0.5, nx, ny, 4.5);
    ng.addColorStop(0, '#f0e0a8');
    ng.addColorStop(0.45, '#9a7228');
    ng.addColorStop(1, '#2e1604');
    ctx.beginPath();
    ctx.arc(nx, ny, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = ng;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,8,2,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(15,6,1,0.5)';
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(nx - 2, ny); ctx.lineTo(nx + 2, ny); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(nx, ny - 2); ctx.lineTo(nx, ny + 2); ctx.stroke();
  };

  const NX = 10;
  drawNail(BOARD_X + NX, BOARD_TOP + NX - 4);
  drawNail(BOARD_RIGHT - NX, BOARD_TOP + NX - 4);
  drawNail(BOARD_X + NX, BOARD_BOT - NX + 4);
  drawNail(BOARD_RIGHT - NX, BOARD_BOT - NX + 4);
  for (let p = 0; p < PLANK_COUNT - 1; p++) {
    const ny = BOARD_TOP + (p + 1) * (PLANK_H + PLANK_GAP) - PLANK_GAP / 2;
    drawNail(BOARD_X + BOARD_W / 2, ny);
  }

  // ── Name text ─────────────────────────────────────────────────────────────
  const textX = BOARD_X + 22;
  ctx.font = 'bold 29px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(28, 10, 2, 0.72)';
  ctx.fillText(name, textX + 2, H / 2 + 2);
  ctx.fillStyle = 'rgba(248, 230, 178, 0.97)';
  ctx.fillText(name, textX, H / 2);

  // ── Score circle ──────────────────────────────────────────────────────────
  if (score !== undefined) {
    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 4;

    // Circle fill — wood radial gradient matching the oval
    const sg = ctx.createRadialGradient(SCORE_CX - 10, SCORE_CY - 14, 4, SCORE_CX, SCORE_CY, SCORE_R * 1.05);
    sg.addColorStop(0, '#C8904A');
    sg.addColorStop(0.5, '#A87030');
    sg.addColorStop(1, '#7A4A18');
    ctx.beginPath();
    ctx.arc(SCORE_CX, SCORE_CY, SCORE_R, 0, Math.PI * 2);
    ctx.fillStyle = sg;
    ctx.fill();

    ctx.shadowColor = 'transparent';

    // Grain lines on circle
    drawGrain(ctx, SCORE_CX - SCORE_R, SCORE_CY - SCORE_R, SCORE_R * 2, SCORE_R * 2, 199);

    // Top sheen
    const ssh = ctx.createRadialGradient(SCORE_CX - 8, SCORE_CY - 16, 2, SCORE_CX, SCORE_CY, SCORE_R);
    ssh.addColorStop(0, 'rgba(255,230,155,0.25)');
    ssh.addColorStop(0.5, 'rgba(255,230,155,0.05)');
    ssh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(SCORE_CX, SCORE_CY, SCORE_R, 0, Math.PI * 2);
    ctx.fillStyle = ssh;
    ctx.fill();

    // Outer ring
    ctx.beginPath();
    ctx.arc(SCORE_CX, SCORE_CY, SCORE_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(30,12,3,0.9)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Inner bevel ring
    ctx.beginPath();
    ctx.arc(SCORE_CX, SCORE_CY, SCORE_R - 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(210,175,95,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Score number
    ctx.font = 'bold 54px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(28, 10, 2, 0.72)';
    ctx.fillText(String(score), SCORE_CX + 2, SCORE_CY + 2);
    ctx.fillStyle = 'rgba(248, 230, 178, 0.97)';
    ctx.fillText(String(score), SCORE_CX, SCORE_CY);
  }

  prev?.dispose();
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export function Nameplate3D({ name, cardImageSrc, position, meshScale = 1, score }: Nameplate3DProps) {
  const meshRef = useRef<any>(null);
  const { camera } = useThree();
  const [texture, setTexture] = useState<CanvasTexture | null>(null);
  const portraitRef = useRef<HTMLImageElement | null>(null);

  // Rebuild texture when score changes (portrait already cached)
  useEffect(() => {
    if (portraitRef.current !== null || score === undefined) {
      setTexture(prev => buildTexture(name, portraitRef.current, score, prev));
    }
  }, [score, name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) {
        portraitRef.current = img;
        setTexture(prev => buildTexture(name, img, score, prev));
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        portraitRef.current = null;
        setTexture(prev => buildTexture(name, null, score, prev));
      }
    };
    img.src = cardImageSrc;
    return () => { cancelled = true; };
  }, [name, cardImageSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    if (meshRef.current) meshRef.current.quaternion.copy(camera.quaternion);
  });

  if (!texture) return null;

  return (
    <mesh ref={meshRef} position={position} scale={[meshScale, meshScale, meshScale]}>
      <planeGeometry args={[NAMEPLATE_W, NAMEPLATE_H]} />
      <meshBasicMaterial map={texture} transparent alphaTest={0.02} depthTest={false} toneMapped={false} />
    </mesh>
  );
}
