// Types and scene data for the tutorial — no logic here.

export type TriggerKind =
  | { kind: 'TUTORIAL_OPEN' }
  | { kind: 'ANY_CARD_PLACED' }
  | { kind: 'CARD_PLACED'; row: number; col: number }
  | { kind: 'TURN_START' }
  | { kind: 'CELLS_FILLED'; count: number }
  | { kind: 'CONTINUE_BUTTON' };

export type HighlightTarget =
  | { kind: 'PLAYER_HAND' }
  | { kind: 'OPPONENT_HAND'; revealCount: number }
  | { kind: 'HAND_CARD'; index: number }
  | { kind: 'BOARD_CELL'; row: number; col: number }
  | { kind: 'SCORE_DISPLAY' }
  | { kind: 'NONE' };

export interface DialogueLine {
  text: string;
  pauseAfterMs?: number;
  beat?: boolean;
}

export interface XochitlMove {
  cardId: number;
  row: number;
  col: number;
}

export interface TutorialScene {
  id: string;
  trigger: TriggerKind;
  dialogue: DialogueLine[];
  highlights: HighlightTarget[];
  xochitlMoveAfter?: XochitlMove;
  /** Delay before Xochitl's move fires after dialogue ends. Default 800ms. */
  xochitlMoveDelayMs?: number;
  allowPlayerAction: boolean;
  autoAdvance?: boolean;
}

// Xochitl's scripted moves in order:
// 1. Swamp Sprite (106) → [1,1]
// 2. Reed Dancer  (107) → [0,0]
// 3. Mud Golem    (108) → [2,0]
// 4. Bog Witch    (109) → [2,2]
// 5. Swamp King   (110) → [0,2]

export const TUTORIAL_SCENES: TutorialScene[] = [
  // ── SCENE 0 — Introduction ─────────────────────────────────────────────
  {
    id: 'intro',
    trigger: { kind: 'TUTORIAL_OPEN' },
    dialogue: [
      { text: 'So. A new soul wanders into my swamp.', pauseAfterMs: 1500 },
      { text: 'You want to play? Then let me show you the rules before I take your cards.' },
      { text: 'Each of us holds five cards. Yours are face-up so you can see them. Mine are... mostly hidden.' },
      { text: 'I show you three of mine. The other two stay secret. That is the nature of this game — partial knowledge, partial trust.' },
      { text: 'Between us: a nine-cell board. We take turns placing one card per turn until every cell is filled. Then we count. Whoever owns the most cards wins.' },
      { text: 'You go first. Look at your cards — tap one to learn its shape.' },
    ],
    highlights: [
      { kind: 'PLAYER_HAND' },
      { kind: 'OPPONENT_HAND', revealCount: 3 },
    ],
    allowPlayerAction: false,
  },

  // ── SCENE 1 — Card Anatomy ─────────────────────────────────────────────
  {
    id: 'card_anatomy',
    trigger: { kind: 'CONTINUE_BUTTON' },
    dialogue: [
      { text: 'See those numbers? Each edge of a card has a rank — one to ten.' },
      { text: 'Top, right, bottom, left. These are the card\'s fighting edges.' },
      { text: 'When you place a card next to one of mine, the touching edges are compared. If yours is higher — my card flips to your colour.' },
      { text: 'That is a capture. That is how you win.' },
      { text: 'Now place a card. Any empty cell on the board will glow when you select one.' },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    allowPlayerAction: true,
  },

  // ── SCENE 2 — First Placement (player places any card) ─────────────────
  {
    id: 'first_placement',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'There. Your card is on the board. Now it belongs to the game.' },
      { text: 'Watch.' },
    ],
    highlights: [{ kind: 'NONE' }],
    xochitlMoveAfter: { cardId: 106, row: 1, col: 1 },
    xochitlMoveDelayMs: 1200,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 3 — Xochitl places, teach capture ────────────────────────────
  {
    id: 'xochitl_first_move',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'My first move. Nothing dramatic. I am simply warming up.' },
      { text: 'Your Vine Creeper. Six on its bottom edge.' },
      { text: 'My Sprite has only three on its top. If your card sits above mine... do the maths.' },
      { text: 'Place it above my card. See what happens.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', index: 1 },
      { kind: 'BOARD_CELL', row: 1, col: 1 },
      { kind: 'BOARD_CELL', row: 0, col: 1 },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 4 — Capture happens ──────────────────────────────────────────
  {
    id: 'capture_reaction',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'Ha! My Sprite is yours now.' },
      { text: 'Six beats three. That is a capture. Your colour, your card — for now.' },
      { text: 'Watch the score. Every card on the board counts. But this game is not over.' },
    ],
    highlights: [{ kind: 'SCORE_DISPLAY' }],
    xochitlMoveAfter: { cardId: 107, row: 0, col: 0 },
    xochitlMoveDelayMs: 1000,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 5 — Mid game, River Drake hint ──────────────────────────────
  {
    id: 'mid_game',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'My Reed Dancer. She dances at the edge. No capture this turn — sometimes patience is the move.' },
      { text: 'You have River Drake. Seven on two edges. Think about where a card like that could reach two of mine at once.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', index: 2 },
    ],
    xochitlMoveAfter: { cardId: 108, row: 2, col: 0 },
    xochitlMoveDelayMs: 2500,
    allowPlayerAction: true,
  },

  // ── SCENE 6 — Multi-adjacency after Mud Golem ─────────────────────────
  {
    id: 'multi_adjacency',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'My Golem. Six on top. Six on the right. Sturdy.' },
      { text: 'Notice — adjacency works in all four directions. Left, right, above, below. Every empty cell you choose touches its neighbours.' },
      { text: 'River Drake has seven on the left edge. My Reed Dancer has only one on the right. Interesting.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', index: 2 },
      { kind: 'BOARD_CELL', row: 1, col: 0 },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 7 — Scoring explanation (after 6 cells filled) ──────────────
  {
    id: 'scoring',
    trigger: { kind: 'CELLS_FILLED', count: 6 },
    dialogue: [
      { text: 'Three cells remain. Let us talk about the score.' },
      { text: 'Every card on the board in your colour counts. So do the cards still in your hand.' },
      { text: 'When all nine cells are filled, whoever has the most cards wins. Nine total on the board. Five remaining in hands. Fourteen cards — whoever holds eight or more wins.' },
      { text: 'Close games are decided in the final three moves.' },
    ],
    highlights: [{ kind: 'SCORE_DISPLAY' }],
    xochitlMoveAfter: { cardId: 109, row: 2, col: 2 },
    xochitlMoveDelayMs: 1500,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 8 — Climax ──────────────────────────────────────────────────
  {
    id: 'climax',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'Bog Witch. She is not here to be polite.' },
      { text: 'The game shifts. Do not panic.' },
      { text: 'You are holding something, aren\'t you. I can feel it.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', index: 4 },
    ],
    xochitlMoveAfter: { cardId: 110, row: 0, col: 2 },
    xochitlMoveDelayMs: 3000,
    allowPlayerAction: true,
  },

  // ── SCENE 9 — Final move ──────────────────────────────────────────────
  {
    id: 'final_move',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'Hm. You held that back well.' },
    ],
    highlights: [{ kind: 'NONE' }],
    allowPlayerAction: false,
    autoAdvance: true,
  },
];
