/**
 * Mechanics coverage audit.
 *
 * Cross-references what the random-battle sets actually put on the field
 * against what the engine implements, so the gap is a number rather than a
 * guess. Run it after touching the sim:
 *
 *   npx tsx packages/server/scripts/audit-mechanics.ts
 *
 * CAVEAT, stated plainly: this measures whether the engine *mentions* a name,
 * not whether it implements it correctly. It catches "we forgot this
 * entirely", which is the failure mode that produced every reported bug so
 * far. Correctness is the job of packages/sim/test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gen } from '@simple-showdown/data';

const simSrc = ['battle.ts', 'damage.ts', 'pokemon.ts', 'stats.ts', 'side.ts']
  .map((f) => fs.readFileSync(path.join('packages', 'sim', 'src', f), 'utf8')).join('\n');

const sets = JSON.parse(
  fs.readFileSync(path.join('packages', 'data', 'src', 'gen9randombattle.json'), 'utf8'),
) as Record<string, {
  abilities?: string[]; items?: string[];
  roles?: Record<string, { abilities?: string[]; moves?: string[]; items?: string[] }>;
}>;

/** The engine "knows" a name if it appears as a string literal or a table key. */
function known(name: string): boolean {
  return simSrc.includes(`'${name}'`)
    || simSrc.includes(`"${name}"`)
    || simSrc.includes(`${name}:`);
}
const toId = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]/g, '');

const abilityUse = new Map<string, number>();
const moveUse = new Set<string>();
const itemUse = new Set<string>();
for (const entry of Object.values(sets)) {
  const abilities = new Set<string>(entry.abilities ?? []);
  for (const i of entry.items ?? []) itemUse.add(i);
  for (const role of Object.values(entry.roles ?? {})) {
    for (const a of role.abilities ?? []) abilities.add(a);
    for (const m of role.moves ?? []) moveUse.add(m);
    for (const i of role.items ?? []) itemUse.add(i);
  }
  for (const a of abilities) abilityUse.set(a, (abilityUse.get(a) ?? 0) + 1);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// --- abilities -------------------------------------------------------------
const missingAbilities = [...abilityUse.entries()].filter(([a]) => !known(a))
  .sort((x, y) => y[1] - x[1]);
section('ABILITIES');
console.log(`  in random sets : ${abilityUse.size}`);
console.log(`  implemented    : ${abilityUse.size - missingAbilities.length}`);
console.log(`  missing        : ${missingAbilities.length}`
  + `  (on ${missingAbilities.reduce((s, [, n]) => s + n, 0)} of ${Object.keys(sets).length} species entries)`);
for (const [a, n] of missingAbilities) console.log(`    ${String(n).padStart(3)}x  ${a}`);

// --- moves -----------------------------------------------------------------
/**
 * A move needs bespoke engine code when its dex entry carries no effect the
 * generic pipeline can act on. Those are only "missing" if the engine does not
 * name the move id somewhere.
 */
const GENERIC_FIELDS = [
  'status', 'volatileStatus', 'boosts', 'heal', 'weather', 'terrain',
  'selfSwitch', 'secondaries', 'drain', 'recoil', 'multihit', 'damage', 'ohko',
  'sideCondition', 'forceSwitch', 'self', 'overrideOffensiveStat', 'selfdestruct',
];
const needsCode: string[] = [];
for (const name of moveUse) {
  const m = gen.moves.get(name) as unknown as Record<string, unknown> | undefined;
  if (!m) { needsCode.push(`${name} (NOT IN DEX)`); continue; }
  if (known(toId(name))) continue; // the engine names it explicitly

  const isStatus = m['category'] === 'Status';
  const generic = GENERIC_FIELDS.some((f) => m[f] !== undefined && m[f] !== null);

  // A plain attack — type, category and a real base power — is fully served by
  // the generic damage pipeline and needs nothing bespoke.
  const plainAttack = !isStatus && (m['basePower'] as number) > 0;

  const reason = m['slotCondition'] || m['pseudoWeather']
    ? 'field/slot condition'
    : isStatus && !generic
      ? 'status move with no declarative effect'
      : !isStatus && (m['basePower'] as number) === 0
        && m['damage'] === undefined && m['ohko'] === undefined
        ? 'computed base power'
        : m['overrideDefensiveStat']
          ? 'defensive stat override'
          : '';

  if (!plainAttack && reason) needsCode.push(`${name} [${reason}]`);
  else if (plainAttack && m['overrideDefensiveStat']) {
    needsCode.push(`${name} [defensive stat override]`);
  }
}
section('MOVES needing bespoke code');
console.log(`  in random sets : ${moveUse.size}`);
console.log(`  unhandled      : ${needsCode.length}`);
if (needsCode.length) console.log(`    ${needsCode.sort().join(', ')}`);

// --- pivot moves -----------------------------------------------------------
section('SELF-SWITCH (PIVOT) MOVES');
const pivots = [...moveUse].filter((n) => {
  const m = gen.moves.get(n) as unknown as { selfSwitch?: unknown } | undefined;
  return !!m?.selfSwitch;
}).sort();
console.log(`  ${pivots.join(', ')}`);
console.log(`  engine forwards selfSwitch: ${simSrc.includes('selfSwitch') ? 'yes' : 'NO'}`);

// --- volatiles -------------------------------------------------------------
section('VOLATILE STATUSES USED BY THOSE MOVES');
const volatiles = new Map<string, string[]>();
for (const name of moveUse) {
  const m = gen.moves.get(name) as unknown as {
    volatileStatus?: string; self?: { volatileStatus?: string };
    secondaries?: { volatileStatus?: string }[];
  } | undefined;
  if (!m) continue;
  const ids = [
    m.volatileStatus, m.self?.volatileStatus,
    ...(m.secondaries ?? []).map((s) => s?.volatileStatus),
  ];
  for (const id of ids) {
    if (!id) continue;
    volatiles.set(id, [...(volatiles.get(id) ?? []), name]);
  }
}
let volMissing = 0;
for (const [id, moves] of [...volatiles].sort((a, b) => b[1].length - a[1].length)) {
  const ok = known(id);
  if (!ok) volMissing++;
  console.log(`  ${ok ? 'ok     ' : 'MISSING'} ${id.padEnd(18)} ${moves.slice(0, 5).join(', ')}`
    + `${moves.length > 5 ? ` (+${moves.length - 5})` : ''}`);
}

// --- items -----------------------------------------------------------------
section('ITEMS');
const missingItems = [...itemUse].filter((i) => !known(toId(i))).sort();
console.log(`  in random sets : ${itemUse.size}`);
console.log(`  unreferenced   : ${missingItems.length}`);
if (missingItems.length) console.log(`    ${missingItems.join(', ')}`);

// --- summary ---------------------------------------------------------------
section('SUMMARY');
const total = missingAbilities.length + needsCode.length + volMissing + missingItems.length;
console.log(`  abilities ${missingAbilities.length} | moves ${needsCode.length}`
  + ` | volatiles ${volMissing} | items ${missingItems.length}`);
console.log(total === 0
  ? '  nothing in the random-battle pool is unimplemented'
  : `  ${total} gaps remain`);
