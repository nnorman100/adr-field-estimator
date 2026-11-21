// The proposal's layout options (docs/plans/S5.md, S5a-9b): the company's chosen layout, its own
// clauses, and the plain letter. The mandated sentences are the engine's (./documents.ts) and are
// handed in, never written here: this file only orders them and adds the room words the technician
// recorded (S5a-10) and the work as "{item}: up to {quantity} {unit}" (S4-4d's per-room quantities).

import { z } from 'zod';

import { money } from './decimal';
import type { JObj } from './json';
import type { Room } from './inspection';
import type { Table } from './table';
import type { PriceLine } from './values';

const CLAUSE = z.strictObject({ title: z.string(), text: z.string() });

/** The company's document settings the proposal prints: its layout and its own clauses, as entered. */
export const LAYOUT_SETTINGS = z
  .strictObject({
    proposal_layout: z.enum(['itemized', 'letter']).default('itemized'),
    company_clauses: z.array(CLAUSE).max(10).default([]),
  })
  .default({ proposal_layout: 'itemized', company_clauses: [] });

/** One room's words for the letter, in the record's room order: its findings note and prep tasks. */
export const ROOM_WORDS = z.array(
  z.strictObject({
    name: z.string(),
    findings: z.string().default(''),
    prep_tasks: z.array(z.string()).max(10).default([]),
  }),
);

export type LayoutSettings = z.output<typeof LAYOUT_SETTINGS>;
export type RoomWords = z.output<typeof ROOM_WORDS>[number];

/** A line of work in the letter; its price only when the price table shows the line breakdown. */
export type LetterLine = { text: string; total?: string };

export type ProposalLetter = {
  /** Every room of the job by name, in the record's order, a room with no lines included. */
  area_inspected: string[];
  /** The mandated findings sentence (the property's age). */
  findings: string[];
  /** One paragraph per room that has a findings note, exactly as recorded. */
  room_findings: Array<{ room: string; text: string }>;
  /** The mandated recommendations: lead and asbestos testing (before 1978), protective equipment. */
  recommendations: string[];
  /** Per room with work: its prep tasks, each marked with an asterisk, then its lines. */
  room_work: Array<{ room: string; prep_tasks: string[]; lines: LetterLine[] }>;
  /** Work priced for the whole job rather than for one room. */
  job_work: LetterLine[];
  /** The mandated sentence on additional affected materials, after the work. */
  additional: string;
};

/** The rooms' words, checked against the rooms priced: the same rooms in the same order. */
export function roomWordsFor(rooms: Room[], words: RoomWords[] | null): RoomWords[] {
  if (words === null) return rooms.map((room) => ({ name: room.name, findings: '', prep_tasks: [] }));
  if (words.length !== rooms.length || words.some((room, index) => room.name !== rooms[index]?.name)) {
    throw new Error('The room findings and prep tasks do not match the rooms.');
  }
  return words;
}

function letterLine(line: PriceLine, labels: Map<string, string>, showPrices: boolean): LetterLine {
  const label = line.itemId === null ? undefined : labels.get(line.itemId);
  // Approved additional work (no price-list item) keeps the engine's own sentence for it.
  const factor = line.multiplier ? ` x${line.multiplier.normalize().format('f')}` : '';
  const text = label === undefined ? line.description : `${label}: up to ${line.quantity.normalize().format('f')} ${line.unit}${factor}`;
  return showPrices ? { text, total: money(line.total).toString() } : { text };
}

export function letterOf(input: {
  rooms: Room[];
  words: RoomWords[];
  lines: PriceLine[];
  table: Table;
  findings: string[];
  recommendations: string[];
  additional: string;
}): ProposalLetter {
  const labels = new Map(input.table.items.map((item) => [item.item_id, item.customer_description || item.name]));
  const showPrices = input.table.policy.show_line_breakdown;
  // Every priced line is listed, the job charges included, so the letter's lines account for the price.
  const roomWork = input.rooms.flatMap((room, index) => {
    const prepTasks = (input.words[index]?.prep_tasks ?? []).map((task) => `* ${task}`);
    const lines = input.lines.filter((line) => line.room === room.name).map((line) => letterLine(line, labels, showPrices));
    return prepTasks.length || lines.length ? [{ room: room.name, prep_tasks: prepTasks, lines }] : [];
  });
  const names = new Set(input.rooms.map((room) => room.name));
  return {
    area_inspected: input.rooms.map((room) => room.name),
    findings: input.findings,
    room_findings: input.words.filter((room) => room.findings.trim() !== '').map((room) => ({ room: room.name, text: room.findings })),
    recommendations: input.recommendations,
    room_work: roomWork,
    job_work: input.lines.filter((line) => line.room === null || !names.has(line.room)).map((line) => letterLine(line, labels, showPrices)),
    additional: input.additional,
  };
}

/** The proposal's layout keys, added to the engine's proposal only when the company set them. */
export function layoutKeys(settings: LayoutSettings, letter: () => ProposalLetter): JObj {
  const keys: JObj = {};
  if (settings.company_clauses.length) keys.company_clauses = settings.company_clauses.map((clause) => ({ title: clause.title, text: clause.text }));
  if (settings.proposal_layout === 'letter') keys.letter = letter() as unknown as JObj;
  return keys;
}
