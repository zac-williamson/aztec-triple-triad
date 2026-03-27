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
  | { kind: 'HAND_CARD'; cardId: number }
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
  /** Speaker portrait to show — default 'xochitl' */
  speaker?: 'xochitl' | 'timmy';
  xochitlMoveAfter?: XochitlMove;
  /** CPU auto-move: picks the card by ID, AI chooses the cell */
  cpuAutoMove?: { cardId: number };
  /** Delay before CPU move fires after dialogue ends. Default 800ms. */
  xochitlMoveDelayMs?: number;
  allowPlayerAction: boolean;
  autoAdvance?: boolean;
}

// ── Board layout ───────────────────────────────────────────────────────
//
// Xochitl's 5 scripted moves:
//   1. Swamp Sprite (106) → [1,1]   (centre)
//   2. Reed Dancer  (107) → [0,0]   (top-left)
//   3. Mud Golem    (108) → [2,0]   (bottom-left)
//   4. Bog Witch    (109) → [2,2]   (bottom-right)
//   5. Swamp King   (110) → [0,2]   (top-right)
//
// Player's 4 forced placements:
//   1. Vine Creeper (102) → [0,1]   (captures Swamp Sprite from above)
//   2. River Drake  (103) → [1,0]   (captures Reed Dancer from right)
//   3. Marsh Hawk   (104) → [2,1]
//   4. Storm Elder  (105) → [1,2]
//
// Stone Lizard (101) stays in hand (never placed).

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
      { text: 'I go first. But look at your cards while you wait — tap one to see its edges.' },
    ],
    highlights: [
      { kind: 'PLAYER_HAND' },
      { kind: 'OPPONENT_HAND', revealCount: 3 },
    ],
    allowPlayerAction: false,
  },

  // ── SCENE 1 — Card Anatomy + Xochitl's first move ─────────────────────
  {
    id: 'card_anatomy',
    trigger: { kind: 'CONTINUE_BUTTON' },
    dialogue: [
      { text: 'See those numbers? Each edge of a card has a rank — one to ten.' },
      { text: 'Top, right, bottom, left. These are the card\'s fighting edges.' },
      { text: 'When you place a card next to one of mine, the touching edges are compared. If yours is higher — my card flips to your colour.' },
      { text: 'That is a capture. That is how you win.' },
      { text: 'I will go first. Watch.' },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    xochitlMoveAfter: { cardId: 106, row: 1, col: 1 },
    xochitlMoveDelayMs: 900,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 2 — Player places Vine Creeper above Swamp Sprite ───────────
  {
    id: 'capture_setup',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'Your Vine Creeper. Six on its bottom edge.' },
      { text: 'My Sprite has only three on its top. If your card sits above mine... do the maths.' },
      { text: 'Place it above my card. See what happens.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', cardId: 102 },
      { kind: 'BOARD_CELL', row: 0, col: 1 },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 3 — Capture reaction + Xochitl plays Reed Dancer ────────────
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

  // ── SCENE 4 — Player places River Drake ───────────────────────────────
  {
    id: 'mid_game',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'My Reed Dancer. She dances at the edge. No capture this turn — sometimes patience is the move.' },
      { text: 'River Drake has seven on the left edge. My Reed Dancer has only one on the right. Interesting.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', cardId: 103 },
      { kind: 'BOARD_CELL', row: 1, col: 0 },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 5 — Reaction + Xochitl plays Mud Golem ─────────────────────
  {
    id: 'mid_reaction',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'My Golem. Six on top. Six on the right. Sturdy.' },
      { text: 'Notice — adjacency works in all four directions. Left, right, above, below. Every empty cell you choose touches its neighbours.' },
    ],
    highlights: [{ kind: 'NONE' }],
    xochitlMoveAfter: { cardId: 108, row: 2, col: 0 },
    xochitlMoveDelayMs: 1200,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 6 — Player places Marsh Hawk ────────────────────────────────
  {
    id: 'scoring',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'Six cells filled. Let us talk about the score.' },
      { text: 'Every card on the board in your colour counts. So do the cards still in your hand.' },
      { text: 'When all nine cells are filled, whoever has the most cards wins.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', cardId: 104 },
      { kind: 'BOARD_CELL', row: 2, col: 1 },
      { kind: 'SCORE_DISPLAY' },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 7 — Reaction + Xochitl plays Bog Witch ─────────────────────
  {
    id: 'scoring_reaction',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'Bog Witch. She is not here to be polite.' },
      { text: 'The game shifts. Do not panic.' },
    ],
    highlights: [{ kind: 'NONE' }],
    xochitlMoveAfter: { cardId: 109, row: 2, col: 2 },
    xochitlMoveDelayMs: 1200,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 8 — Player places Storm Elder ───────────────────────────────
  {
    id: 'climax',
    trigger: { kind: 'TURN_START' },
    dialogue: [
      { text: 'Two cells remain. You are holding something, aren\'t you. I can feel it.' },
    ],
    highlights: [
      { kind: 'HAND_CARD', cardId: 105 },
      { kind: 'BOARD_CELL', row: 1, col: 2 },
    ],
    allowPlayerAction: true,
  },

  // ── SCENE 9 — Reaction + Xochitl plays Swamp King (game ends) ────────
  {
    id: 'final_move',
    trigger: { kind: 'ANY_CARD_PLACED' },
    dialogue: [
      { text: 'Hm. You held that back well.' },
    ],
    highlights: [{ kind: 'NONE' }],
    xochitlMoveAfter: { cardId: 110, row: 0, col: 2 },
    xochitlMoveDelayMs: 1500,
    allowPlayerAction: false,
    autoAdvance: true,
  },
];

// ════════════════════════════════════════════════════════════════════════
// Phase 2 — Timmy
//
// Timmy goes first (5 moves). Player places 4 cards, keeps 1 in hand.
// No forced card/cell restrictions — player picks freely.
// Timmy uses cpuAutoMove (simple AI picks first empty cell).
//
// Timmy's move order:
//   1. Timmy (203)            — his "best" card
//   2. Timmy's Friend (201)
//   3. Timmy's Other Friend (202)
//   4. Old Boot (204)         — shock reveal
//   5. Lost Cat (205)         — despair
// ════════════════════════════════════════════════════════════════════════

export const TIMMY_SCENES: TutorialScene[] = [
  // ── SCENE 0 — Timmy intro ─────────────────────────────────────────────
  {
    id: 'timmy_intro',
    trigger: { kind: 'TUTORIAL_OPEN' },
    speaker: 'timmy',
    dialogue: [
      { text: "Hey! You're the new player, right? I'm Timmy!", pauseAfterMs: 1200 },
      { text: "Don't let the swamp lady scare you. She's all talk." },
      { text: "I've been saving my BEST cards for a game like this. You're gonna be surprised." },
      { text: "My hidden cards? Let's just say... they're LEGENDARY." },
      { text: "I'll go first! Watch this — my strongest fighter!" },
    ],
    highlights: [
      { kind: 'OPPONENT_HAND', revealCount: 3 },
    ],
    cpuAutoMove: { cardId: 203 },
    xochitlMoveDelayMs: 900,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 1 — Player's 1st turn ──────────────────────────────────────
  {
    id: 'timmy_p1',
    trigger: { kind: 'TURN_START' },
    speaker: 'timmy',
    dialogue: [
      { text: "Impressive, right? Two on every edge. Perfectly balanced." },
      { text: "Go ahead, try to beat THAT." },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    allowPlayerAction: true,
  },

  // ── SCENE 2 — Timmy plays Friend ─────────────────────────────────────
  {
    id: 'timmy_t2',
    trigger: { kind: 'ANY_CARD_PLACED' },
    speaker: 'timmy',
    dialogue: [
      { text: "Oh. Okay. Lucky shot." },
    ],
    highlights: [{ kind: 'NONE' }],
    cpuAutoMove: { cardId: 201 },
    xochitlMoveDelayMs: 800,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 3 — Player's 2nd turn ──────────────────────────────────────
  {
    id: 'timmy_p2',
    trigger: { kind: 'TURN_START' },
    speaker: 'timmy',
    dialogue: [
      { text: "My friend here is tougher than he looks." },
      { text: "...Okay, maybe not. But my hidden cards will make up for it." },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    allowPlayerAction: true,
  },

  // ── SCENE 4 — Timmy plays Other Friend ────────────────────────────────
  {
    id: 'timmy_t3',
    trigger: { kind: 'ANY_CARD_PLACED' },
    speaker: 'timmy',
    dialogue: [
      { text: "This is fine. I still have my secret weapons." },
      { text: "Any moment now, you'll see my REAL power." },
    ],
    highlights: [{ kind: 'NONE' }],
    cpuAutoMove: { cardId: 202 },
    xochitlMoveDelayMs: 800,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 5 — Player's 3rd turn ──────────────────────────────────────
  {
    id: 'timmy_p3',
    trigger: { kind: 'TURN_START' },
    speaker: 'timmy',
    dialogue: [
      { text: "Just you wait. My next card will change EVERYTHING." },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    allowPlayerAction: true,
  },

  // ── SCENE 6 — Old Boot reveal ─────────────────────────────────────────
  {
    id: 'timmy_boot',
    trigger: { kind: 'ANY_CARD_PLACED' },
    speaker: 'timmy',
    dialogue: [
      { text: "Time for my legendary hidden card! Behold—" },
      { text: "...What?? How did THAT get in there?! That's an old boot!", pauseAfterMs: 1500 },
      { text: "This wasn't supposed to happen! Someone switched my cards!" },
    ],
    highlights: [{ kind: 'NONE' }],
    cpuAutoMove: { cardId: 204 },
    xochitlMoveDelayMs: 800,
    allowPlayerAction: false,
    autoAdvance: true,
  },

  // ── SCENE 7 — Player's 4th turn ──────────────────────────────────────
  {
    id: 'timmy_p4',
    trigger: { kind: 'TURN_START' },
    speaker: 'timmy',
    dialogue: [
      { text: "Okay okay, but my LAST hidden card — that one's the REAL deal." },
      { text: "Trust me. You're not ready for this." },
    ],
    highlights: [{ kind: 'PLAYER_HAND' }],
    allowPlayerAction: true,
  },

  // ── SCENE 8 — Lost Cat reveal + game ends ─────────────────────────────
  {
    id: 'timmy_cat',
    trigger: { kind: 'ANY_CARD_PLACED' },
    speaker: 'timmy',
    dialogue: [
      { text: "And my final hidden card... prepare yourself..." },
      { text: "...A lost cat?! Are you KIDDING me?!", pauseAfterMs: 1500 },
      { text: "Who packed my deck?! XOCHITL!! Was this you?!" },
    ],
    highlights: [{ kind: 'NONE' }],
    cpuAutoMove: { cardId: 205 },
    xochitlMoveDelayMs: 1000,
    allowPlayerAction: false,
    autoAdvance: true,
  },
];
