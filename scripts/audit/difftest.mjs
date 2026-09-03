/**
 * Differential testing: the TypeScript rules engine as an oracle for the circuit.
 *
 * packages/game-logic and circuits/game_move are independent implementations of
 * the same rules, written separately — so each is a free oracle for the other.
 * Hand-written cases cannot cover cascading multi-captures (invariant T7): the
 * interesting boards are combinatorial and I cannot enumerate them by intuition,
 * which is the failure this whole exercise is correcting.
 *
 * Rather than execute the circuit from JS — which would mean reimplementing
 * pedersen over the 30-field preimage, i.e. testing my reimplementation — this
 * GENERATES Noir tests from engine-played games. The oracle is JS; the execution
 * is in-circuit, using the circuit's own hash.
 *
 * Two kinds are emitted per move:
 *   - positive: the engine's exact transition. The circuit must ACCEPT.
 *   - negative: the same transition with one owner flipped and the score moved
 *     to match, re-hashed so the hash check cannot mask it. Must REJECT.
 *
 * The negative is the one with teeth. A flipped owner on a cascade board is
 * precisely the "captured one card too many" bug that positive tests cannot see.
 *
 *   node scripts/audit/difftest.mjs 20     # 20 games
 *   cd circuits && nargo test --package game_move
 */
import { createGame, getCardsByIds, placeCard } from '../../packages/game-logic/dist/index.js';
import { readFileSync, writeFileSync } from 'fs';

const GAMES = Number(process.argv[2] ?? 10);
const SRC = 'circuits/game_move/src/main.nr';
const BEGIN = '// ===== BEGIN GENERATED DIFFTEST (scripts/audit/difftest.mjs) =====';
const END = '// ===== END GENERATED DIFFTEST =====';

// The hands the circuit's own test helpers commit to, so get_p1_commit() and
// p1_card_ids() line up with what we play.
const P1 = [1, 2, 3, 4, 5];
const P2 = [10, 11, 12, 13, 14];

let seed = 0x9e3779b9;
const rnd = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };

const flat = (b) => {
  const o = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cell = b[r][c];
    o.push(cell.card ? cell.card.id : 0);
    o.push(cell.owner === 'player1' ? 1 : cell.owner === 'player2' ? 2 : 0);
  }
  return o;
};
const owners = (b) => {
  const o = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cell = b[r][c];
    o.push(cell.originalOwner === 'player1' ? 1 : cell.originalOwner === 'player2' ? 2 : 0);
  }
  return o;
};
const arr = (a) => `[${a.join(', ')}]`;

const cases = [];
for (let g = 0; g < GAMES; g++) {
  let st = createGame(getCardsByIds(P1), getCardsByIds(P2));
  for (let move = 0; move < 9; move++) {
    const mover = st.currentTurn;
    const hand = mover === 'player1' ? st.player1Hand : st.player2Hand;
    const empties = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!st.board[r][c].card) empties.push([r, c]);
    if (!hand.length || !empties.length) break;

    const hi = rnd(hand.length);
    const [row, col] = empties[rnd(empties.length)];
    const before = st;
    const card = hand[hi];
    const after = placeCard(before, mover, hi, row, col).newState;

    const isP1 = mover === 'player1';
    const bb = flat(before.board), ba = flat(after.board);
    const oob = owners(before.board), ooa = owners(after.board);
    const sb = [before.player1Score, before.player2Score];
    const sa = [after.player1Score, after.player2Score];
    const ended = after.status === 'finished';
    const winner = !ended ? 0
      : after.winner === 'player1' ? 1 : after.winner === 'player2' ? 2 : 3;

    // A cell whose owner changed but which was not the placed cell: a capture.
    // Flipping one such owner back is "captured one fewer than the rules say",
    // and flipping an unchanged neighbour is "captured one too many". Either is
    // the cascade bug shape.
    const placedIdx = row * 3 + col;
    let flipIdx = -1;
    for (let i = 0; i < 9; i++) {
      if (i !== placedIdx && ba[i * 2] !== 0 && ba[i * 2 + 1] !== bb[i * 2 + 1]) { flipIdx = i; break; }
    }

    cases.push({ g, move, isP1, cardId: card.id, row, col, bb, ba, oob, ooa, sb, sa, ended, winner, flipIdx });
    st = after;
  }
}

const body = cases.map((c, n) => {
  const commits = 'get_p1_commit(), get_p2_commit()';
  const hand = c.isP1 ? 'p1_card_ids(), P1_BLINDING' : 'p2_card_ids(), P2_BLINDING';
  const turnAfter = c.isP1 ? 2 : 1;
  const player = c.isP1 ? 1 : 2;

  const positive = `
#[test]
fn diff_g${c.g}_m${c.move}_accepts_engine_transition() {
    let bb: [Field; 18] = ${arr(c.bb)};
    let ba: [Field; 18] = ${arr(c.ba)};
    let oob: [Field; 9] = ${arr(c.oob)};
    let ooa: [Field; 9] = ${arr(c.ooa)};
    let sb: [Field; 2] = ${arr(c.sb)};
    let sa: [Field; 2] = ${arr(c.sa)};
    let sh = hash_board_state(bb, sb, ${player}, oob);
    let eh = hash_board_state(ba, sa, ${turnAfter}, ooa);
    main(${commits}, sh, eh, ${c.ended ? 1 : 0}, ${c.winner},
         ${player}, ${c.cardId}, ${c.row}, ${c.col}, bb, ba, sb, sa, ${player}, oob, ooa, ${hand});
}`;

  if (c.flipIdx < 0) return positive;

  // Flip one captured cell back, and move the score to match, so only the
  // capture rule can object. Re-hashed, so the hash check cannot mask it.
  const ba2 = [...c.ba];
  ba2[c.flipIdx * 2 + 1] = c.bb[c.flipIdx * 2 + 1];
  const sa2 = c.isP1 ? [c.sa[0] - 1, c.sa[1] + 1] : [c.sa[0] + 1, c.sa[1] - 1];

  const negative = `
#[test(should_fail)]
fn diff_g${c.g}_m${c.move}_rejects_uncaptured_flip() {
    let bb: [Field; 18] = ${arr(c.bb)};
    let ba: [Field; 18] = ${arr(ba2)};
    let oob: [Field; 9] = ${arr(c.oob)};
    let ooa: [Field; 9] = ${arr(c.ooa)};
    let sb: [Field; 2] = ${arr(c.sb)};
    let sa: [Field; 2] = ${arr(sa2)};
    let sh = hash_board_state(bb, sb, ${player}, oob);
    let eh = hash_board_state(ba, sa, ${turnAfter}, ooa);
    main(${commits}, sh, eh, ${c.ended ? 1 : 0}, ${c.winner},
         ${player}, ${c.cardId}, ${c.row}, ${c.col}, bb, ba, sb, sa, ${player}, oob, ooa, ${hand});
}`;
  return positive + negative;
}).join('\n');

/** Regex-escape: BEGIN contains parentheses, which silently became capture
 *  groups and made the replace a no-op — the generator reported writing 351
 *  tests and wrote none. */
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const src = readFileSync(SRC, 'utf8');
const block = `${BEGIN}\n// ${cases.length} engine-played moves from ${GAMES} games. Regenerate, do not edit.\n${body}\n${END}`;
const next = src.includes(BEGIN)
  ? src.replace(new RegExp(`${esc(BEGIN)}[\\s\\S]*${esc(END)}`), block)
  : `${src}\n${block}\n`;
writeFileSync(SRC, next);

const negatives = cases.filter(c => c.flipIdx >= 0).length;
console.log(`${cases.length} moves from ${GAMES} games -> ${cases.length} positive, ${negatives} negative tests`);
console.log(`captures seen: ${negatives} (moves with at least one flipped cell)`);
