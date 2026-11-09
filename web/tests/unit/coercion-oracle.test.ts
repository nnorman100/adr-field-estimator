// Differential coercion check: every stored probe from scripts/pricing_oracle_coercion.py, run
// through the TypeScript readers, must be accepted or rejected as the Python models did and dump
// the same value. This file never regenerates the probes.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { claimOf, identityOf, photoRecord } from '../../src/engine/documents';
import { distinctRooms, dumpInspection, validateInspection } from '../../src/engine/inspection';
import { itemToJ, normalizeTable, policyToJ } from '../../src/engine/table';
import { aiNote, technicianStatement } from '../../src/engine/text';
import { canonical, parseJson, type JObj, type JVal } from '../../src/engine/json';

const root = fileURLToPath(
  new URL('../../../tests/fixtures/pricing-oracle/coercion/', import.meta.url),
);

type Path = Array<string | number>;

function dump(model: string, data: JVal): JVal {
  if (model === 'inspection') return dumpInspection(validateInspection(data));
  if (model === 'rooms') {
    const inspection = validateInspection(data);
    distinctRooms(inspection);
    return dumpInspection(inspection);
  }
  if (model === 'table') {
    const table = normalizeTable(data, true, []);
    return { items: table.items.map((item) => itemToJ(item)), policy: policyToJ(table.policy) };
  }
  if (model === 'ai_note') return { text: aiNote(String((data as JObj).text)) };
  if (model === 'statement') return { text: technicianStatement(String((data as JObj).text)) };
  if (model === 'canonical') return { value: canonical((data as JObj).value as JVal) };
  if (model === 'photo') return photoRecord(data);
  if (model === 'identity') return identityOf(data);
  if (model === 'claim') return claimOf(data);
  throw new Error(`Unknown model ${model}`);
}

function setAt(data: JVal, path: Path, value: JVal): JVal {
  const copy = parseJson(canonical(data));
  let target = copy as Record<string | number, JVal>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, JVal>;
  target[path[path.length - 1] as string | number] = value;
  return copy;
}

function getAt(data: JVal, path: Path): { value: JVal } | { missing: true } {
  let current: JVal = data;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number' && key < current.length) {
      current = current[key] as JVal;
    } else if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      typeof key === 'string' &&
      key in current
    ) {
      current = (current as JObj)[key] as JVal;
    } else return { missing: true };
  }
  return { value: current };
}

function outcome(model: string, template: JVal, path: Path, input: JVal): string {
  let dumped: JVal;
  try {
    dumped = dump(model, setAt(template, path, input));
  } catch {
    return 'rejected';
  }
  const found = getAt(dumped, path);
  return 'missing' in found ? 'accepted, missing' : `accepted, ${canonical(found.value)}`;
}

describe('coercion oracle', () => {
  const files = readdirSync(root).filter((name) => name.endsWith('.json'));

  it('has stored probes', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`matches ${file}`, () => {
      const body = parseJson(readFileSync(`${root}/${file}`, 'utf8')) as JObj;
      const path = (body.path as JVal[]).map((key) =>
        typeof key === 'string' ? key : (key as { value: number }).value,
      );
      const problems: string[] = [];
      for (const raw of body.probes as JObj[]) {
        const input = raw.input as JVal;
        const expected = raw.accepted
          ? 'missing' in raw
            ? 'accepted, missing'
            : `accepted, ${canonical(raw.value as JVal)}`
          : 'rejected';
        const actual = outcome(String(body.model), body.template as JVal, path, input);
        if (actual !== expected) problems.push(`${canonical(input)}: ${actual} != ${expected}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
