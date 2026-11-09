// Every pinned oracle case must match the stored answer. This file never regenerates fixtures.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/engine/evaluate';
import { canonical, parseJson, type JObj, type JVal } from '../../src/engine/json';

const root = fileURLToPath(new URL('../../../tests/fixtures/pricing-oracle/', import.meta.url));

function load(file: string): JVal {
  return parseJson(readFileSync(`${root}/${file}`, 'utf8'));
}

function object(value: JVal, label: string): JObj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JObj;
}

function same(actual: JVal, expected: JVal): boolean {
  return canonical(actual) === canonical(expected);
}

function stage(value: JVal): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as JObj;
  return typeof row.stage === 'string' ? row.stage : null;
}

describe('pricing oracle', () => {
  const manifest = object(load('manifest.json'), 'manifest');
  const cases = manifest.cases;
  if (!Array.isArray(cases)) throw new Error('manifest cases');

  it('matches every stored case', () => {
    const problems: string[] = [];
    for (const entry of cases) {
      const row = object(entry, 'case');
      const file = typeof row.file === 'string' ? row.file : '';
      const id = typeof row.id === 'string' ? row.id : file;
      const body = object(load(file), id);
      const expected = object(body.expected ?? null, id);
      const actual = evaluate(body.input ?? null);
      const expectedStage = expected.rejected ? stage(expected.rejected) : null;
      if (expectedStage !== actual.rejected) {
        problems.push(`${id}: stage ${actual.rejected ?? 'ok'} != ${expectedStage ?? 'ok'}`);
        continue;
      }
      if (expected.pricing && actual.pricing) {
        const want = object(expected.pricing, id);
        const got = actual.pricing;
        for (const key of ['lines', 'buckets', 'totals', 'low', 'high'] as const) {
          if (!same(got[key] ?? null, want[key] ?? null)) {
            problems.push(`${id}: pricing.${key}`);
            break;
          }
        }
      } else if (Boolean(expected.pricing) !== Boolean(actual.pricing)) {
        problems.push(`${id}: pricing presence`);
      }
      if (expected.warnings && actual.warnings) {
        if (!same(actual.warnings, expected.warnings)) problems.push(`${id}: warnings`);
      } else if (Boolean(expected.warnings) !== Boolean(actual.warnings)) {
        problems.push(`${id}: warnings presence`);
      }
      if (expected.proposal && actual.proposal) {
        const want = object(expected.proposal, id);
        if (want.sha256 !== actual.proposal.sha256 || want.canonical_bytes_base64 !== actual.proposal.base64) {
          const sections = ['normalized_inspection', 'documents', 'pricing']
            .filter((key) => {
              const left = key === 'normalized_inspection' ? actual.normalized : key === 'documents' ? actual.documents : actual.pricing;
              return left && expected[key] && !same(left, expected[key] as JVal);
            })
            .join(',');
          problems.push(`${id}: proposal ${sections || 'bytes'}`);
        }
      } else if (Boolean(expected.proposal) !== Boolean(actual.proposal)) {
        problems.push(`${id}: proposal presence`);
      }
    }
    expect(problems.slice(0, 12)).toEqual([]);
  });
});
