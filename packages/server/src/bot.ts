/**
 * The practice bot. Two tiers:
 *  - easy: random usable move, random lead, random replacement.
 *  - hard: scores every usable move by power x STAB x type effectiveness
 *    against the current foe (with a dash of randomness so it's not a
 *    perfect robot), and picks replacements by best offensive matchup.
 */
import { typeEffectiveness } from '@simple-showdown/sim';
import type { BattleRoom } from './battle-room.js';
import type { SideID } from '@simple-showdown/sim';

interface BotRequest {
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: [boolean];
  active?: { moves: { id: string; disabled: boolean; pp: number }[] }[];
  side: { pokemon: { active: boolean; condition: string }[] };
}

export function runBot(room: BattleRoom, side: SideID, line: string): void {
  if (!line.startsWith('|request|')) return;
  let request: BotRequest;
  try {
    request = JSON.parse(line.slice('|request|'.length));
  } catch {
    return;
  }
  if (request.wait) return;

  // A small delay so pacing feels like an opponent thinking.
  setTimeout(() => {
    if (room.battle.ended) return;
    room.submitChoice(side, chooseFor(room, side, request));
  }, 600);
}

function chooseFor(room: BattleRoom, side: SideID, request: BotRequest): string {
  if (request.teamPreview) {
    const n = request.side.pokemon.length;
    const order = Array.from({ length: n }, (_, i) => i + 1);
    const lead = 1 + Math.floor(Math.random() * n);
    return `team ${[lead, ...order.filter((x) => x !== lead)].join('')}`;
  }

  const mySide = room.battle.sides[side];
  const foe = room.battle.sides[side === 'p1' ? 'p2' : 'p1'].active;

  if (request.forceSwitch) {
    const options = request.side.pokemon
      .map((p, i) => (!p.active && !p.condition.endsWith('fnt') ? i : -1))
      .filter((i) => i >= 0);
    if (!options.length) return 'default';
    if (!room.botHard || !foe) {
      return `switch ${options[Math.floor(Math.random() * options.length)]! + 1}`;
    }
    // Hard: best offensive matchup — strongest move it could use vs the foe.
    let best = options[0]!;
    let bestScore = -1;
    for (const i of options) {
      const mon = mySide.team[i];
      if (!mon) continue;
      let score = 0;
      for (const slot of mon.moveSlots) {
        if (slot.pp <= 0 || slot.move.basePower <= 0) continue;
        const stab = mon.types.includes(slot.move.type) ? 1.5 : 1;
        score = Math.max(score, slot.move.basePower * stab * typeEffectiveness(slot.move.type, foe.types));
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return `switch ${best + 1}`;
  }

  if (request.active) {
    const moves = request.active[0]?.moves ?? [];
    const usable = moves.map((m, i) => (!m.disabled && m.pp > 0 ? i : -1)).filter((i) => i >= 0);
    if (!usable.length) return 'move 1'; // struggle
    const active = mySide.active;
    if (!room.botHard || !foe || !active || Math.random() < 0.15) {
      return `move ${usable[Math.floor(Math.random() * usable.length)]! + 1}`;
    }
    // Hard: argmax of power x STAB x effectiveness x accuracy.
    let best = usable[0]!;
    let bestScore = -1;
    for (const i of usable) {
      const slot = active.moveSlots[i];
      if (!slot) continue;
      const move = slot.move;
      const stab = active.types.includes(move.type) ? 1.5 : 1;
      const acc = move.accuracy === true ? 1 : move.accuracy / 100;
      const power = move.basePower || (move.category !== 'Status' ? 50 : 0);
      let score = power * stab * typeEffectiveness(move.type, foe.types) * acc;
      // Value a status move a little when the foe is healthy and unstatused.
      if (move.category === 'Status' && (move.status || move.boosts || move.weather || move.sideCondition)) {
        score = foe.status === '' && foe.hp > foe.maxhp * 0.7 ? 55 : 20;
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return `move ${best + 1}`;
  }

  return 'default';
}
