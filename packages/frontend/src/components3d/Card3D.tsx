import { useState, useEffect } from 'react';
import {
  TextureLoader,
  SRGBColorSpace,
  LinearMipmapLinearFilter,
  LinearFilter,
  DoubleSide,
} from 'three';
import type { Card, Player } from '../types';
import { CARD_ASPECT } from './utils/cardPositions';
import { TEXTURES } from '../assets/modelManifest';

// ── Module-level texture cache ──
// Use `any` to avoid dual @types/three version conflicts between root and packages/frontend
const textureCache = new Map<string, any>();

function useCardTexture(cardId: number, faceDown: boolean, isBoard?: boolean) {
  let texPath: string;
  if (faceDown) {
    texPath = TEXTURES.cardBack;
  } else if (isBoard) {
    texPath = `/cards/board/card-${cardId}-board.png`;
  } else {
    texPath = `/cards/final/card-${cardId}.png`;
  }

  const [texture, setTexture] = useState<any>(textureCache.get(texPath) ?? null);

  useEffect(() => {
    if (textureCache.has(texPath)) {
      setTexture(textureCache.get(texPath)!);
      return;
    }

    let cancelled = false;
    new TextureLoader().load(
      texPath,
      (tex) => {
        if (cancelled) return;
        tex.minFilter = LinearMipmapLinearFilter;
        tex.magFilter = LinearFilter;
        tex.colorSpace = SRGBColorSpace;
        textureCache.set(texPath, tex);
        setTexture(tex);
      },
      undefined,
      (err: unknown) => {
        console.warn(`[Card3D] Failed to load texture: ${texPath}`, err);
      },
    );

    return () => { cancelled = true; };
  }, [texPath]);

  return texture;
}

// ── Component ──

interface Card3DProps {
  card: Card;
  faceDown?: boolean;
  /** When set, uses the square board card texture with blue/red background */
  boardOwner?: 'blue' | 'red';
  width?: number;
  renderOrder?: number;
  opacity?: number;
  depthWrite?: boolean;
  /** Emissive glow color — rendered as a border behind the card, picked up by Bloom */
  glowColor?: string;
}

// Owner color values for the background quad
const OWNER_COLORS: Record<string, string> = {
  blue: '#1a3080',
  red: '#801a1a',
};

const GLOW_PAD = 0.02;

export function Card3D({
  card,
  faceDown = false,
  boardOwner,
  width = 0.38,
  renderOrder,
  opacity = 1,
  depthWrite = true,
  glowColor,
}: Card3DProps) {
  const texture = useCardTexture(card.id, faceDown, !!boardOwner);
  // Board cards are square (1:1), hand cards use CARD_ASPECT
  const height = boardOwner ? width : width * CARD_ASPECT;

  if (!texture) return null;

  return (
    <group>
      {/* Emissive glow border — Bloom post-processing creates the soft halo */}
      {glowColor && (
        <mesh renderOrder={renderOrder != null ? renderOrder - 2 : undefined} position={[0, 0, -0.002]}>
          <planeGeometry args={[width + GLOW_PAD * 2, height + GLOW_PAD * 2]} />
          <meshStandardMaterial
            color="#000000"
            emissive={glowColor}
            emissiveIntensity={3}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
      )}
      {/* Colored background quad for board cards (sits behind the card texture) */}
      {boardOwner && (
        <mesh renderOrder={renderOrder != null ? renderOrder - 1 : undefined} position={[0, 0, -0.001]}>
          <planeGeometry args={[width, height]} />
          <meshBasicMaterial
            color={OWNER_COLORS[boardOwner]}
            toneMapped={false}
            depthWrite={depthWrite}
          />
        </mesh>
      )}
      {/* Card texture */}
      <mesh renderOrder={renderOrder}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={texture}
          transparent
          alphaTest={0.05}
          opacity={opacity}
          side={DoubleSide}
          toneMapped={false}
          depthWrite={depthWrite}
        />
      </mesh>
    </group>
  );
}
