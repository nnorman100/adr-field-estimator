// Inputs that Python normalizes or rejects before it builds documents and the proposal hash.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/engine/evaluate';
import { canonical, parseJson, type JObj, type JVal } from '../../src/engine/json';

const root = fileURLToPath(
  new URL('../../../tests/fixtures/pricing-oracle/cases/', import.meta.url),
);

function fixture(name: string): { input: JObj; expected: JObj } {
  const body = parseJson(readFileSync(`${root}/${name}.json`, 'utf8')) as JObj;
  return { input: body.input as JObj, expected: body.expected as JObj };
}

function at(value: JVal, ...path: Array<string | number>): JObj {
  let current: JVal = value;
  for (const key of path) current = (current as Record<string | number, JVal>)[key] as JVal;
  return current as JObj;
}

function approval(input: JObj): JObj {
  return at(input, 'data', 'extras', 0, 'approval');
}

function firstPhoto(input: JObj): JObj {
  return at(input, 'photos', 0);
}

describe('JSON floats', () => {
  it('hashes equivalent float spellings identically', () => {
    const plain = fixture('v1-photos-ocr-states').input;
    const padded = fixture('v1-photos-ocr-states').input;
    firstPhoto(plain).location = parseJson(
      '{"source":"device","latitude":35.1,"longitude":-119.0,"accuracy_m":12.5}',
    );
    firstPhoto(padded).location = parseJson(
      '{"source":"device","latitude":35.10,"longitude":-119.000,"accuracy_m":1.25e1}',
    );
    const left = evaluate(plain);
    const right = evaluate(padded);
    expect(left.rejected).toBeNull();
    expect(right.proposal?.sha256).toBe(left.proposal?.sha256);
  });

  it('reads a float decimal as its shortest text', () => {
    const { input, expected } = fixture('v1-extras-approved-book-snapshot');
    at(input, 'data', 'extras', 0).hours = parseJson('1.250');
    const result = evaluate(input);
    expect(result.rejected).toBeNull();
    expect(result.proposal?.sha256).toBe(at(expected, 'proposal').sha256);
  });
});

describe('approval timestamps', () => {
  it('stores a +00:00 approval time as Z', () => {
    for (const text of ['2026-10-25T12:00:00+00:00', '2026-10-25T12:00:00.000000-00:00']) {
      const { input, expected } = fixture('v1-extras-approved-book-snapshot');
      approval(input).accepted_at = text;
      const result = evaluate(input);
      expect(result.rejected).toBeNull();
      expect(result.proposal?.sha256).toBe(at(expected, 'proposal').sha256);
    }
  });

  it('keeps microseconds and a non-zero offset', () => {
    const { input } = fixture('v1-extras-approved-book-snapshot');
    approval(input).accepted_at = '2026-10-25T05:00:00.5-07:00';
    const result = evaluate(input);
    expect(result.rejected).toBeNull();
    expect(at(result.normalized as JVal, 'extras', 0, 'approval').accepted_at).toBe(
      '2026-10-25T05:00:00.500000-07:00',
    );
  });

  it('rejects an approval time that is not a date and time', () => {
    for (const text of ['2026-02-30T12:00:00Z', 'yesterday', '2026-10-25T24:00:00Z']) {
      const { input } = fixture('v1-extras-approved-book-snapshot');
      approval(input).accepted_at = text;
      expect(evaluate(input).rejected).toBe('inspection');
    }
  });
});

describe('claim date of loss', () => {
  it('rejects an impossible calendar date', () => {
    for (const text of ['2026-02-30', '2025-13-01', '0000-01-01']) {
      const { input } = fixture('v1-claim-details');
      at(input, 'claim').date_of_loss = text;
      expect(evaluate(input).rejected).toBe('documents');
    }
  });

  it('accepts a leap day', () => {
    const { input } = fixture('v1-claim-details');
    at(input, 'claim').date_of_loss = '2024-02-29';
    expect(evaluate(input).rejected).toBeNull();
  });
});

describe('claim addressee', () => {
  it('keeps a whitespace-only carrier and contact line in the letter', () => {
    const { input, expected } = fixture('v1-claim-details');
    const claim = at(input, 'claim');
    claim.carrier = ' ';
    claim.adjuster_email = '';
    claim.adjuster_phone = '\u00a0';
    const letter = at(expected, 'documents').iicrc_defense_letter as string;
    const result = evaluate(input);
    expect(result.rejected).toBeNull();
    expect(result.documents?.iicrc_defense_letter).toBe(
      letter.replace(
        'Example Mutual\nadjuster@example.invalid \u00b7 555-0199\n',
        ' \n\u00a0\n',
      ),
    );
  });
});

describe('photo log', () => {
  it('rejects a verified photo without a complete meter reading', () => {
    const bad: JVal[] = [
      parseJson('{}'),
      null,
      parseJson(
        '{"meter_detected":true,"meter_type":"M","value":"1","classification":"","notes":"","extra":""}',
      ),
    ];
    for (const ocr of bad) {
      const { input } = fixture('v1-photos-ocr-states');
      firstPhoto(input).ocr = ocr;
      expect(evaluate(input).rejected).toBe('documents');
    }
  });

  it('rejects a reading on another photo that breaks the reading contract', () => {
    const { input } = fixture('v1-photos-ocr-states');
    at(input, 'photos', 1).ocr = parseJson(
      '{"meter_detected":"maybe","meter_type":"","value":"","classification":"","notes":""}',
    );
    expect(evaluate(input).rejected).toBe('documents');
  });

  it('rejects non-integer sizes and out-of-range locations', () => {
    const edits: Array<(photo: JObj) => void> = [
      (photo) => (photo.width = parseJson('1600.5')),
      (photo) => (photo.height = '1200.5'),
      (photo) =>
        (photo.location = parseJson(
          '{"source":"device","latitude":91,"longitude":0,"accuracy_m":1}',
        )),
      (photo) =>
        (photo.location = parseJson(
          '{"source":"device","latitude":0,"longitude":-181,"accuracy_m":1}',
        )),
      (photo) =>
        (photo.location = parseJson(
          '{"source":"device","latitude":0,"longitude":0,"accuracy_m":-1}',
        )),
      (photo) => (photo.location = parseJson('{"source":"not_shared","note":"x"}')),
    ];
    for (const edit of edits) {
      const { input } = fixture('v1-photos-ocr-states');
      edit(firstPhoto(input));
      expect(evaluate(input).rejected).toBe('documents');
    }
  });

  it('logs integer coordinates as floats and integral sizes as integers', () => {
    const { input, expected } = fixture('v1-photos-ocr-states');
    firstPhoto(input).location = parseJson(
      '{"source":"device","latitude":35,"longitude":-119,"accuracy_m":0}',
    );
    firstPhoto(input).width = parseJson('1600.0');
    const result = evaluate(input);
    expect(result.rejected).toBeNull();
    const log = at(result.documents as JVal, 'photo_audit_log', 0);
    expect(canonical(log.location as JVal)).toBe(
      '{"accuracy_m":0.0,"latitude":35.0,"longitude":-119.0,"source":"device"}',
    );
    expect(canonical(log.width as JVal)).toBe(
      canonical(at(expected, 'documents', 'photo_audit_log', 0).width as JVal),
    );
  });
});

describe('room quantity overrides', () => {
  function quantities(input: JObj): string[] {
    const result = evaluate(input);
    expect(result.rejected).toBeNull();
    const lines = (result.pricing as JObj).lines as JObj[];
    return lines.map((line) => `${String(line.item_id)}=${canonical(line.quantity as JVal)}`);
  }

  it('prices a cleared wet floor as the whole floor', () => {
    const plain = fixture('v2-area-basis-wet_floor').input;
    const cleared = fixture('v2-area-basis-wet_floor').input;
    delete at(plain, 'data', 'rooms', 0).wet_floor_sf;
    delete at(cleared, 'data', 'rooms', 0).wet_floor_sf;
    at(cleared, 'data').quantity_overrides = parseJson(
      '{"Kitchen:wet_floor_sf":{"measured":"120","entered":"0","reason":"Whole floor wet"}}',
    );
    const priced = quantities(cleared);
    expect(priced).toContain('antimicrobial=160.0');
    expect(priced).toEqual(quantities(plain));
  });
});
