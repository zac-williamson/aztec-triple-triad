# Axolotl Arena — Tutorial Script

## Overview

An interactive tutorial disguised as a real game. The player faces **Xochitl**, a mysterious elder spirit who guards the swamp. She guides the player through the rules via in-world dialogue, reacting to their moves in real time. The tutorial uses a **fixed, pre-scripted deck** on both sides so dialogue can reference specific cards and situations predictably.

---

## Tutorial Character: Xochitl

> *An ancient swamp spirit who has played Axolotl Arena for centuries. Warm but mischievous. She speaks in short, atmospheric lines — never lecturing, always baiting the player forward.*

**Portrait:** Use a dedicated `card-tutorial.png` (placeholder: use card-2.png).
**Voice tone:** Wise elder. Hints of dry humour. Never condescending.

---

## Fixed Decks

These specific cards must be used so the script's dialogue matches the board state.

### Xochitl's Hand (Opponent — shown face-up for tutorial purposes)

| Slot | Card Name   | Top | Right | Bottom | Left | Notes                          |
|------|-------------|-----|-------|--------|------|--------------------------------|
| 1    | Swamp Sprite|  3  |   2   |   4    |  2   | Weak card, placed first        |
| 2    | Reed Dancer |  5  |   1   |   3    |  5   | Strong left/right              |
| 3    | Mud Golem   |  6  |   6   |   2    |  4   | Player will capture this       |
| 4    | Bog Witch   |  7  |   3   |   7    |  5   | Near-equal to player's best    |
| 5    | Swamp King  |  8  |   7   |   8    |  6   | Xochitl's strongest — saved for last |

### Player's Hand

| Slot | Card Name    | Top | Right | Bottom | Left | Notes                          |
|------|--------------|-----|-------|--------|------|--------------------------------|
| 1    | Stone Lizard |  2  |   5   |   2    |  3   | First card player places       |
| 2    | Vine Creeper |  4  |   4   |   6    |  1   | Demonstrates capture mechanic  |
| 3    | River Drake  |  7  |   3   |   5    |  7   | Player uses to flip Mud Golem  |
| 4    | Marsh Hawk   |  5  |   6   |   4    |  6   | Contested mid-game card        |
| 5    | Storm Elder  |  8  |   8   |   6    |  7   | Player's strongest — kept for climax |

---

## Scene-by-Scene Script

---

### SCENE 1 — Introduction

*Fade in from black. The swamp scene loads. No cards are on the board yet. A nameplate with Xochitl's portrait appears on the left. Her dialogue appears as a typed-in text bubble near her portrait.*

---

**[TRIGGER: Tutorial opens]**

> **Xochitl:** "So. A new soul wanders into my swamp."

*[Beat — 1.5s]*

> **Xochitl:** "You want to play? Then let me show you the rules before I take your cards."

**[UI HIGHLIGHT: Both player hands]**

> **Xochitl:** "Each of us holds five cards. Yours are face-up so you can see them. Mine are... mostly hidden."

**[UI HIGHLIGHT: Opponent hand — cards 1–3 glow, cards 4–5 are dim/locked]**

> **Xochitl:** "I show you three of mine. The other two stay secret. That is the nature of this game — partial knowledge, partial trust."

**[UI HIGHLIGHT: The 3×3 board]**

> **Xochitl:** "Between us: a nine-cell board. We take turns placing one card per turn until every cell is filled. Then we count. Whoever owns the most cards wins."

*[Continue button or short delay]*

> **Xochitl:** "You go first. Look at your cards — tap one to learn its shape."

---

### SCENE 2 — Card Anatomy

*Player is prompted to hover over / tap any card in their hand. The card magnifies.*

---

**[TRIGGER: Player taps or hovers over any card in their hand]**

*The card enlarges. Four numbers glow on its edges.*

> **Xochitl:** "See those numbers? Each edge of a card has a rank — one to ten, A being ten."

**[UI HIGHLIGHT: Arrows pointing to top/right/bottom/left ranks]**

> **Xochitl:** "Top, right, bottom, left. These are the card's fighting edges."

> **Xochitl:** "When you place a card next to one of mine, the touching edges are compared. If yours is higher — my card flips to your colour."

> **Xochitl:** "That is a capture. That is how you win."

**[Continue prompt]**

> **Xochitl:** "Now place a card. Any empty cell on the board will glow when you select one."

---

### SCENE 3 — First Placement (Player places Stone Lizard)

*Player selects a card. Empty cells highlight. Tutorial nudges them toward the **centre-left** cell [row 1, col 0] with a soft pulsing arrow.*

---

**[TRIGGER: Player selects a card]**

> **Xochitl:** "Good. The glowing cells are where you may play. Choose wisely — position matters."

**[TRIGGER: Player places any card on the board]**

*Card flies from hand to board cell with animation.*

> **Xochitl:** "There. Your card is on the board. Now it belongs to the game."

> **Xochitl:** "Watch."

*Xochitl places **Swamp Sprite** [3/2/4/2] in the **centre** cell [row 1, col 1].*

> **Xochitl:** "My first move. Nothing dramatic. I am simply warming up."

---

### SCENE 4 — The Capture Mechanic

*This is the critical teaching moment. The player needs to place **Vine Creeper** [4/4/6/1] adjacent to Xochitl's **Swamp Sprite** [3/2/4/2] so that a capture occurs.*

*The tutorial nudges the player toward **[row 0, col 1]** (above the Swamp Sprite) with a subtle arrow. Vine Creeper's bottom rank is 6; Swamp Sprite's top rank is 3 — a guaranteed capture.*

---

**[TRIGGER: It is the player's turn again]**

**[UI HIGHLIGHT: Vine Creeper in player hand, gentle pulse]**

> **Xochitl:** "Your Vine Creeper. Six on its bottom edge."

**[UI HIGHLIGHT: Swamp Sprite on board, Xochitl's card]**

> **Xochitl:** "My Sprite has only three on its top. If your card sits above mine... do the maths."

**[TRIGGER: Player selects Vine Creeper]**

*Empty cells highlight. A subtle golden arrow or glow appears on cell [row 0, col 1].*

> **Xochitl:** "Place it above my card. See what happens."

**[TRIGGER: Player places Vine Creeper at [row 0, col 1]]**

*Capture animation triggers — Swamp Sprite flips to the player's colour with a flash and spark.*

> **Xochitl:** "Ha! My Sprite is yours now."

> **Xochitl:** "Six beats three. That is a capture. Your colour, your card — for now."

**[UI HIGHLIGHT: Score counters update]**

> **Xochitl:** "Watch the score. You have four cards in your colour. I have six. The board is the battlefield — every card on it counts."

> **Xochitl:** "But this game is not over."

---

### SCENE 5 — Mid Game (Xochitl fights back)

*Xochitl plays **Reed Dancer** [5/1/3/5] at **[row 0, col 0]**. Reed Dancer's right rank (1) faces Vine Creeper's left rank (1) — a tie, no capture. Xochitl is being tactical.*

---

**[TRIGGER: Xochitl places Reed Dancer]**

> **Xochitl:** "My Reed Dancer. She dances at the edge. No capture this turn — sometimes patience is the move."

*[Player's turn prompt]*

> **Xochitl:** "You have River Drake. Seven on two edges. Think about where a card like that could reach two of mine at once."

---

### SCENE 6 — Multi-Adjacency & The Mud Golem Capture

*Xochitl places **Mud Golem** [6/6/2/4] at **[row 2, col 1]** (bottom-centre). Now the player has a choice — placing **River Drake** [7/3/5/7] at **[row 1, col 1]** (where Swamp Sprite was, now empty after it was captured... wait, let me re-think the board state).*

*Let me reconsider. After the captures so far: [row 0,col 1] = Vine Creeper (player), [row 1,col 1] = captured Swamp Sprite (player colour), [row 0,col 0] = Reed Dancer (Xochitl).*

*Xochitl places Mud Golem at [row 2, col 0]. Mud Golem's top rank is 6. The cell above it [row 1, col 0] is empty — the player can play River Drake [7/3/5/7] there. River Drake's bottom rank (5) vs Mud Golem's top (6) — no capture downward. But River Drake's left rank (7) vs Reed Dancer's right rank (1) — CAPTURE of Reed Dancer. Good teaching moment for left/right direction.*

---

**[TRIGGER: Xochitl places Mud Golem at [row 2, col 0]]**

> **Xochitl:** "My Golem. Six on top. Six on the right. Sturdy."

**[UI HIGHLIGHT: Mud Golem's top rank glowing, then Reed Dancer's right rank]**

> **Xochitl:** "Notice — adjacency works in all four directions. Left, right, above, below. Every empty cell you choose touches its neighbours."

*[Player's turn prompt. Tutorial hints River Drake toward [row 1, col 0].]*

> **Xochitl:** "River Drake has seven on the left edge. My Reed Dancer has only one on the right. Interesting."

**[TRIGGER: Player places River Drake at [row 1, col 0]]**

*Reed Dancer flips to player colour.*

> **Xochitl:** "My dancer... gone. Well played."

> **Xochitl:** "You checked the left edge. Good. Players who only look up and down are easy to beat."

---

### SCENE 7 — Scoring Explanation

*After a few more moves, the board is filling up. Pause for a score check.*

---

**[TRIGGER: 6 cells are filled]**

> **Xochitl:** "Three cells remain. Let us talk about the score."

**[UI HIGHLIGHT: Score circles on the banners]**

> **Xochitl:** "Every card on the board in your colour counts. So do the cards still in your hand."

> **Xochitl:** "At this moment — count yours."

*[Short pause — player can look at board and hand]*

> **Xochitl:** "When all nine cells are filled, whoever has the most cards wins. Nine total on the board. Five remaining in hands. Fourteen cards — whoever holds eight or more wins."

> **Xochitl:** "Close games are decided in the final three moves."

---

### SCENE 8 — The Climax (Final Moves)

*Xochitl plays **Bog Witch** [7/3/7/5] aggressively. The board is tense. Two cells remain.*

---

**[TRIGGER: Xochitl plays Bog Witch]**

> **Xochitl:** "Bog Witch. She is not here to be polite."

*Bog Witch captures one of the player's cards via the top rank.*

> **Xochitl:** "The game shifts. Do not panic."

*[Player has Storm Elder [8/8/6/7] in hand — their strongest.]*

> **Xochitl:** "You are holding something, aren't you. I can feel it."

**[TRIGGER: Player selects Storm Elder]**

> **Xochitl:** "There it is."

**[TRIGGER: Player places Storm Elder, capturing at least one card]**

> **Xochitl:** "Hm. You held that back well."

---

### SCENE 9 — Final Move & Result

*Xochitl plays her last card — Swamp King [8/7/8/6]. The board is full.*

---

**[TRIGGER: Last card placed]**

*Board fills. Score tallies.*

---

#### Branch A — Player Wins

> **Xochitl:** "..."

*[Long pause]*

> **Xochitl:** "You counted well. Most newcomers forget the hand cards — they only watch the board."

> **Xochitl:** "You win. And by the rules of Axolotl Arena... you may take one of my cards."

**[UI: Card selection screen appears — player picks one of Xochitl's board cards]**

> **Xochitl:** "Choose wisely. A good card in bad hands is just furniture."

**[TRIGGER: Player selects a card]**

> **Xochitl:** "That one. Yes. It suits you."

> **Xochitl:** "Come back when you want a real game."

---

#### Branch B — Xochitl Wins

> **Xochitl:** "Ah. The board does not lie."

> **Xochitl:** "You played well in places. But you hesitated too long in the middle, and I took the corners."

> **Xochitl:** "I take one of your cards, as is tradition."

**[UI: Xochitl "selects" a card — takes the player's weakest remaining card]**

> **Xochitl:** "Do not be downcast. You learned today. Come back and try to win it back."

---

#### Branch C — Draw

> **Xochitl:** "Equal. That is rarer than a win."

> **Xochitl:** "In a draw, no cards are exchanged. The game simply... ends."

> **Xochitl:** "You are more careful than most. We will play again."

---

### SCENE 10 — Tutorial Complete

*After the card trade (or draw), a short summary screen.*

---

> **Xochitl:** "You now know the shape of the game. Let me say it plainly:"

**[UI: Summary card fades in with bullet points as she speaks]**

> **Xochitl:** "Nine cells. Five cards each. Alternate turns."

> **Xochitl:** "Place a card — if its touching rank beats its neighbour's matching rank, you capture it."

> **Xochitl:** "Fill the board. Count your colour. Most cards wins."

> **Xochitl:** "Winner takes one card. Loser learns."

*[Pause]*

> **Xochitl:** "Now go find someone else to beat. The swamp has more players than you think."

**[Button: "Play a Real Game"]**
**[Button: "Play Tutorial Again"]**

---

## Implementation Notes

### Tutorial State Machine

The tutorial runs as a sequence of **named scenes** with **trigger conditions**:

```
Scene → WaitForTrigger → AdvanceToNextScene
```

Triggers are one of:
- `CARD_PLACED(row, col)` — player placed a card at a specific cell
- `CARD_SELECTED(cardIndex)` — player tapped a card in hand
- `TURN_START` — player's turn begins
- `DELAY(ms)` — automatic after timeout
- `ANY_CARD_PLACED` — any placement (for free-form moments)

### Highlight System Needed

- `highlightCell(row, col, style)` — pulsing glow on a board cell
- `highlightHandCard(index, style)` — glow on a specific hand card
- `highlightUI(element)` — glow on HUD elements (score, hand area)
- `showArrow(target)` — directional nudge arrow

### Xochitl AI Moves

Xochitl's moves are **pre-scripted** in the tutorial (not AI-driven):

```typescript
const XOCHITL_MOVES = [
  { card: 'swamp_sprite',  row: 1, col: 1 },
  { card: 'reed_dancer',   row: 0, col: 0 },
  { card: 'mud_golem',     row: 2, col: 0 },
  { card: 'bog_witch',     row: 2, col: 2 },
  { card: 'swamp_king',    row: 0, col: 2 },
];
```

### Dialogue Display

Each dialogue line should:
1. Appear near Xochitl's nameplate (left side of screen)
2. Type in character-by-character (typewriter effect, ~40ms/char)
3. Show a "▶" prompt when the player can continue, or auto-advance after longer lines
4. Support `[Beat]` annotations for pauses mid-scene

### Cards Required

Six new tutorial cards need to be added to the card database (or reuse existing ones with renamed stats):

| Card         | ID    |
|--------------|-------|
| Stone Lizard | t_001 |
| Vine Creeper | t_002 |
| River Drake  | t_003 |
| Marsh Hawk   | t_004 |
| Storm Elder  | t_005 |
| Swamp Sprite | t_006 |
| Reed Dancer  | t_007 |
| Mud Golem    | t_008 |
| Bog Witch    | t_009 |
| Swamp King   | t_010 |

### Skip Tutorial

A **"Skip"** button in the top-right lets experienced players bypass the tutorial at any point. All tutorial progress (completion flag) is stored in `localStorage`.

---

## Open Questions for Review

1. **Should the tutorial be skippable mid-way through, or only at the start?**

The tutorial should be skippable any way through. For a new player on game loadup, a popup should show asking the player if they want to play the tutorial.

2. **Does Xochitl become a recurring character** (e.g. unlockable opponent in a future single-player mode)?

Not yet

3. **Should the tutorial use the real Aztec contract / wallet flow**, or be an offline-only simulation?

Offline only
4. **Localisation**: Is English-only fine for now, or should the dialogue system support multiple languages from the start?

English only is fine for now

5. **Tutorial cards**: Should they be permanently added to the player's collection after completing, or are they one-time-use props?

No the tutorial cards should not be added to the player's collection