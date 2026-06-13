/**
 * Mutable registry of live app state, fed by the testkit bridges
 * (useTestkitBridge, useGameScreenBridge, SceneBridge) and consumed by the
 * window.__triadTest API. Plain module state — no React — so the API can be
 * assembled from main.tsx without access to component internals.
 */
import type { UseAztecReturn } from '../hooks/useAztec';
import type { UseGameReturn } from '../hooks/useGame';
import type { Camera, Scene } from 'three';

export interface GameScreenBridgeState {
  /** Hand index currently selected (click-to-select), null if none. */
  selectedCardIndex: number | null;
  /** A placed card is mid-flight from hand to board. */
  flying: boolean;
  /** A capture flip cascade is running. */
  cascading: boolean;
}

export interface SceneBridgeState {
  camera: Camera;
  scene: Scene;
  /** Canvas size in CSS pixels (matches pointer-event coordinates). */
  size: { width: number; height: number };
  canvas: HTMLCanvasElement;
}

interface Registry {
  aztec: UseAztecReturn | null;
  game: UseGameReturn | null;
  gameScreen: GameScreenBridgeState | null;
  scene: SceneBridgeState | null;
  /** Monotonic counter bumped on every publish — cheap change detection for pollers. */
  seq: number;
}

export const registry: Registry = {
  aztec: null,
  game: null,
  gameScreen: null,
  scene: null,
  seq: 0,
};

export function publishApp(aztec: UseAztecReturn, game: UseGameReturn): void {
  registry.aztec = aztec;
  registry.game = game;
  registry.seq++;
}

export function publishGameScreen(state: GameScreenBridgeState | null): void {
  registry.gameScreen = state;
  registry.seq++;
}

export function publishScene(state: SceneBridgeState | null): void {
  registry.scene = state;
  registry.seq++;
}
