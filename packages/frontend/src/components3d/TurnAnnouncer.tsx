import { useEffect, useRef, useState } from 'react';

interface TurnAnnouncerProps {
  isMyTurn: boolean;
  isFinished: boolean;
}

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  color: string;
  life: number;
}

function runSparks(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  const colors = ['#7bc67e', '#aaffaa', '#ffdd66', '#88ddff', '#ffaa55'];
  const particles: Particle[] = Array.from({ length: 55 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 180 + Math.random() * 520;
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 120,
      size: 3 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
    };
  });

  let lastTime = performance.now();
  let raf = 0;

  const animate = (now: number) => {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let anyAlive = false;
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 600 * dt; // gravity
      p.life -= dt * 1.1;
      if (p.life <= 0) continue;
      anyAlive = true;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * Math.max(0.1, p.life), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    if (anyAlive) {
      raf = requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  raf = requestAnimationFrame(animate);
  return () => cancelAnimationFrame(raf);
}

export function TurnAnnouncer({ isMyTurn, isFinished }: TurnAnnouncerProps) {
  const [phase, setPhase] = useState<'hidden' | 'show' | 'explode'>('hidden');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevTurnRef = useRef(isMyTurn);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (isFinished) return;
    const wasMyTurn = prevTurnRef.current;
    prevTurnRef.current = isMyTurn;
    if (!isMyTurn || wasMyTurn) return;

    setPhase('show');
    cleanupRef.current?.();

    const t1 = setTimeout(() => {
      setPhase('explode');
      if (canvasRef.current) {
        cleanupRef.current = runSparks(canvasRef.current);
      }
      const t2 = setTimeout(() => setPhase('hidden'), 1200);
      return () => clearTimeout(t2);
    }, 1000);

    return () => clearTimeout(t1);
  }, [isMyTurn, isFinished]);

  if (phase === 'hidden') return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, pointerEvents: 'none' }}>
      {/* Spark canvas */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />

      {/* Text */}
      {phase === 'show' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            fontFamily: "'Cinzel', serif",
            fontSize: 'clamp(48px, 8vw, 84px)',
            fontWeight: 900,
            color: '#9be89e',
            letterSpacing: '6px',
            textShadow: [
              '0 0 20px rgba(123,198,126,0.9)',
              '0 0 50px rgba(123,198,126,0.5)',
              '0 4px 8px rgba(0,0,0,0.8)',
            ].join(', '),
            animation: 'turnBounceIn 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards',
          }}>
            YOUR TURN!
          </div>
        </div>
      )}

      <style>{`
        @keyframes turnBounceIn {
          0%   { opacity: 0; transform: scale(0.3) rotate(-4deg); }
          60%  { opacity: 1; transform: scale(1.08) rotate(1deg); }
          100% { opacity: 1; transform: scale(1) rotate(0deg); }
        }
      `}</style>
    </div>
  );
}
