/**
 * Mechanics coverage audit.
 *
 * Cross-references what the random-battle sets actually put on the field
 * against what the engine implements, so the gap is a number rather than a
 * guess. Run it after touching the sim:
 *
 *   npx tsx packages/server/scripts/audit-mechanics.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gen } from '@simple-showdown/data';

const simSrc = ['battle.ts', 'damage.ts', 'pokemon.ts', 'stats.ts', 'side.ts']
  .map((f) => fs.readFileSync(path.join('packages', 'sim', 'src', f), 'utf8')).join('\n');

const sets = JSON.parse(
  fs.readFileSync(path.join('packages', 'data', 'src', 'gen9randombattle.json'), 'utf8'),
) as Record<string, { abilities?: string[]; roles?: Record<string, { abilities?: string[]; moves?: string[] }> }>;

/** The engine "knows" a name if it appears as a string literal or a table key. */
function known(name: string): boolean {
  return simSrc.includes(`'${name}'`)
    || simSrc.includes(`"${name}"`)
    || simSrc.includes(`${name}:`);
}

const abilityUse = new Map<string, number>();
const moveUse = new Set<string>();
for (const entry of Object.values(sets)) {
  const abilities = new Set<string>(entry.abilities ?? []);
  for (const role of Object.values(entry.roles ?? {})) {
    for (const a of role.abilities ?? []) abilities.add(a);
    for (const m of role.moves ?? []) moveUse.add(m);
  }
  for (const a of abilities) abilityUse.set(a, (abilityUse.get(a) ?? 0) + 1);
}

const missing = [...abilityUse.entries()].filter(([a]) => !known(a)).sort((x, y) => y[1] - x[1]);
const covered = abilityUse.size - missing.length;
const affected = missing.reduce((sum, [, n]) => sum + n, 0);

console.log('=== ABILITIES ===');
console.log(`  in random sets : ${abilityUse.size}`);
console.log(`  implemented    : ${covered}`);
console.log(`  missing        : ${missing.length}  (on ${affected} of ${Object.keys(sets).length} species entries)`);
for (const [a, n] of missing) console.log(`    ${String(n).padStart(3)}x  ${a}`);

console.log('\n=== SELF-SWITCH (PIVOT) MOVES ===');
for (const name of [...moveUse].sort()) {
  const m = gen.moves.get(name) as unknown as { selfSwitch?: unknown } | undefined;
  if (m?.selfSwitch) {
    console.log(`  ${name.padEnd(20)} forwarded=${simSrc.includes('selfSwitch') ? 'yes' : 'NO'}`);
  }
}

console.log('\n=== VOLATILE STATUSES USED BY THOSE MOVES ===');
const volatiles = new Map<string, string[]>();
for (const name of moveUse) {
  const m = gen.moves.get(name) as unknown as {
    volatileStatus?: string; secondaries?: { volatileStatus?: string }[];
  } | undefined;
  if (!m) continue;
  const ids = [m.volatileStatus, ...(m.secondaries ?? []).map((s) => s?.volatileStatus)];
  for (const id of ids) {
    if (!id) continue;
    volatiles.set(id, [...(volatiles.get(id) ?? []), name]);
  }
}
for (const [id, moves] of [...volatiles].sort((a, b) => b[1].length - a[1].length)) {
  const mark = known(id) ? 'ok     ' : 'MISSING';
  console.log(`  ${mark} ${id.padEnd(18)} ${moves.slice(0, 5).join(', ')}${moves.length > 5 ? ` (+${moves.length - 5})` : ''}`);
}
