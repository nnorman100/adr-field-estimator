// The four claim documents. Prices and required sentences come from the engine, never from a model.

import { z } from 'zod';

import { companySetupMissing } from './company-setup';
import { Dec, HUNDRED, money, percentText } from './decimal';
import type { JObj, Json } from './json';
import type { Inspection } from './inspection';
import { LAYOUT_SETTINGS, layoutKeys, letterOf, ROOM_WORDS, roomWordsFor } from './proposal-letter';
import { letterParagraph, equipmentSizing } from './sizing';
import type { Table } from './table';
import { aiNote, plain, technicianStatement } from './text';
import { priceAndRange, type End, type Totals } from './totals';
import { adjustmentLines, chars, collapse, lineJson, oneLine, type AdjustmentText, type PriceLine } from './values';


const PHOTO_LOCATION_PRIVACY =
  "Photos taken during the inspection are stamped with the location reported by the technician's phone, when the technician allows it, and that location is part of the photo log.";
const ADDRESS_LOCATION_PRIVACY =
  'When the job address is entered, the typed address is sent to Google Maps to suggest matching addresses, and the selected location is saved with the job.';
const PRETEST = '(this does not include the pretest for lead/asbestos)';
const TESTING =
  "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly.";
const PROTECTION =
  'Per IICRC and EPA protocols, {company} technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.';
const ADDITIONAL =
  'If technicians encounter additional affected building materials beyond the quantities previously described, the project manager will contact the property owner to discuss any additional course of action necessary and the associated cost.';
const EXCLUSIONS =
  'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of {company}. This estimate does not include testing of any kind.';
const REPRICE = 'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.';
const VALIDITY = 'Estimate is valid for 30 days from date of inspection.';
const ROOM_LABELS: Record<string, string> = {
  unfinished_sf: 'Unfinished area',
  finished_sf: 'Finished area',
  wet_floor_sf: 'Wet floor area',
  floor_sf: 'Floor area',
};
const JOB_LABELS: Record<string, string> = {
  emergency_calls: 'Emergency service calls',
  monitoring_hours: 'Monitoring hours',
  haul_loads: 'Haul loads',
  air_scrubbers: 'Air scrubbers',
  hepa_filters: 'HEPA filters',
  matterport_scans: 'Matterport scans',
  dump_truck_loads: 'Dump truck loads',
  equipment_decon: 'Equipment decontamination',
  power_distribution: 'Power distribution',
  labor_hours: 'Labor hours',
  air_movers: 'Air movers',
  dehumidifiers: 'Dehumidifiers',
  drying_days: 'Drying days',
  wood_floor_systems: 'Wood floor systems',
  wood_floor_days: 'Wood floor days',
};


// Items priced from these sources are job charges every job carries; they alone are not work.
const BASELINE_SOURCES = new Set([
  'field:emergency_calls',
  'field:monitoring_hours',
  'field:haul_loads',
  'field:air_scrubbers',
  'field:hepa_filters',
  'after_hours',
]);

function fail(message: string): never {
  throw new Error(message);
}

function parse<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `.${issue.path.join('.')}` : '';
  return fail(`${label}${where}: ${issue?.message ?? 'invalid'}`);
}

function text(min: number, max: number) {
  return z.string().refine((value) => chars(value) >= min && chars(value) <= max, {
    message: `must be ${min} to ${max} characters`,
  });
}

const IDENTITY = z.strictObject({
  company_id: z.string(),
  version: z.number().int().min(1),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  email: z.string(),
  license: z.string(),
  signoff: z.string(),
  logo_data_url: z.string().default(''),
  water_heater_notice: z.string().default(''),
  // The company's own wording for the signed page (S5a-4b document settings). Given both, the setup
  // check also lists an empty one, so documents without them are not signable (S5a-11).
  authorization_text: z.string().optional(),
  payment_terms_text: z.string().optional(),
});

type Identity = z.output<typeof IDENTITY>;

function validDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days;
}

/** A date of loss: blank, or a real calendar date no later than tomorrow. */
function lossDate(raw: string): boolean {
  if (raw === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split('-').map((part) => Number(part)) as [number, number, number];
  if (!validDate(year, month, day)) return false;
  const loss = new Date(2000, 0, 1);
  loss.setFullYear(year, month - 1, day);
  const today = new Date();
  return loss <= new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const claimLine = (max: number) =>
  text(0, max)
    .transform((value) => oneLine(value))
    .default('');

const CLAIM = z.strictObject({
  carrier: claimLine(150),
  claim_number: claimLine(80),
  policy_number: claimLine(80),
  date_of_loss: text(0, 10).refine(lossDate, { message: 'not a past calendar date' }).default(''),
  loss_cause: claimLine(500),
  adjuster_name: claimLine(150),
  adjuster_email: text(0, 254)
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => value === '' || EMAIL.test(value), { message: 'not an email address' })
    .default(''),
  adjuster_phone: claimLine(80),
  deductible: claimLine(40),
});

type Claim = z.output<typeof CLAIM>;

const NOTE = text(0, 1000);
const AI = z.strictObject({
  summary: text(1, 6000),
  suggestions: z.array(NOTE).max(30),
  unpriced_work: z.array(NOTE).max(30),
  testing_advice: z.array(NOTE).max(10).default([]),
});

const OCR = z.strictObject({
  meter_detected: z.boolean(),
  meter_type: text(0, 100),
  value: text(0, 100),
  classification: text(0, 100),
  notes: text(0, 1000),
});

const LOCATION = z
  .strictObject({
    source: z.enum(['device', 'not_available', 'not_shared']),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    accuracy_m: z.number().min(0).max(1000000).nullish(),
  })
  .transform((location, ctx) => {
    const row: JObj = { source: location.source };
    if (location.latitude != null) row.latitude = location.latitude;
    if (location.longitude != null) row.longitude = location.longitude;
    if (location.accuracy_m != null) row.accuracy_m = location.accuracy_m;
    if (Object.keys(row).length !== (location.source === 'device' ? 4 : 1)) {
      ctx.addIssue({ code: 'custom', message: 'a device location needs latitude, longitude and accuracy' });
      return z.NEVER;
    }
    return row;
  });

// A photo of the log. The submitted record (S5a-8) knows a photo's room, shot tag and stored hash,
// but not its capture time, size or a meter reading (meter-photo reading is S7), so those keys are
// optional and a row holds only the keys it was given. A photo with no `ocr_status` was never sent
// for a reading: it is a supporting photo, not one waiting for a reading.
const PHOTO = z
  .object({
    id: z.string(),
    room: z.string(),
    captured_at: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    ocr_status: z.enum(['pending', 'verified', 'no_meter', 'failed']).optional(),
    ocr: OCR.nullish(),
    location: LOCATION.nullish(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters').optional(),
    shot_tag: text(1, 40).optional(),
    album: text(1, 80).optional(),
  })
  .superRefine((photo, ctx) => {
    if (photo.ocr_status === 'verified' && !photo.ocr) {
      ctx.addIssue({ code: 'custom', path: ['ocr'], message: 'a verified photo needs its meter reading' });
    }
  });

type PhotoRow = { row: JObj; room: string; status: string | null; ocr: z.output<typeof OCR> | null };

function photoOf(raw: Json): PhotoRow {
  const photo = parse(PHOTO, raw, 'photo');
  const row: JObj = { id: photo.id, room: photo.room };
  if (photo.captured_at !== undefined) row.captured_at = photo.captured_at;
  if (photo.width !== undefined) row.width = photo.width;
  if (photo.height !== undefined) row.height = photo.height;
  if (photo.ocr_status !== undefined) row.ocr_status = photo.ocr_status;
  if (photo.ocr) row.ocr = photo.ocr;
  if (photo.location) row.location = photo.location;
  if (photo.sha256 !== undefined) row.sha256 = photo.sha256;
  if (photo.shot_tag !== undefined) row.shot_tag = photo.shot_tag;
  if (photo.album !== undefined) row.album = photo.album;
  return { row, room: photo.room, status: photo.ocr_status ?? null, ocr: photo.ocr ?? null };
}

function endJson(end: End): JObj {
  const body: JObj = {
    after_hours: money(end.afterHours).toString(),
    minimum_charge: money(end.minimumCharge).toString(),
    overhead_profit: money(end.overheadProfit).toString(),
    subtotal: money(end.subtotal).toString(),
    tax: money(end.tax).toString(),
    total: money(end.total).toString(),
  };
  if (end.tradeMinimums.length) {
    body.trade_minimums = end.tradeMinimums.map((row) => ({
      amount: money(row.amount).toString(),
      name: row.name,
      trade_id: row.tradeId,
    }));
  }
  return body;
}

function estimateOf(totals: Totals, table: Table): JObj {
  const policy = table.policy;
  const multiplier = Dec.parse(policy.after_hours.multiplier);
  const body: JObj = {
    after_hours_label: totals.afterHoursLabel,
    after_hours_percent: percentText(multiplier.sub(Dec.fromInt(1)).mul(HUNDRED)),
    low: endJson(totals.low),
    mode: totals.mode,
    overhead_profit_percent: percentText(policy.overhead_profit_percent),
    sales_tax_percent: policy.sales_tax.enabled ? percentText(policy.sales_tax.percent) : '0',
    show_line_breakdown: policy.show_line_breakdown,
  };
  if (totals.mode === 'range' && totals.high) body.high = endJson(totals.high);
  const explanation = totals.mode === 'range' ? totals.rangeExplanation : totals.explanation;
  if (explanation !== null) body.explanation = explanation;
  return body;
}

function wording(extra: Inspection['extras'][number], company: string): string {
  const approval = extra.approval;
  if (!approval) return extra.description;
  const hours = extra.hours.normalize().format('f');
  const when = approval.acceptedAt.slice(0, 10);
  return `Additional work, not in ${company} price sheet: ${extra.description}, ${hours} h at $${approval.rate.format('.2f')}/h, approved by ${approval.acceptedByName} on ${when}.`;
}

function notesOf(data: Inspection): JObj[] | null {
  const rooms = new Map<string, string>();
  for (const room of data.rooms) {
    const key = collapse(room.name);
    if (!rooms.has(key)) rooms.set(key, room.name);
  }
  const notes: JObj[] = [];
  for (const [key, override] of Object.entries(data.quantityOverrides ?? {})) {
    const split = key.lastIndexOf(':');
    const name = split >= 0 ? key.slice(0, split) : '';
    const field = split >= 0 ? key.slice(split + 1) : key;
    const room = rooms.get(collapse(name));
    const label = room ? ROOM_LABELS[field] : JOB_LABELS[key];
    if (!label || override.measured.eq(override.entered)) continue;
    const row: JObj = {
      entered: override.entered.toString(),
      label,
      measured: override.measured.toString(),
      reason: override.reason ?? '',
    };
    if (room) row.room = room;
    notes.push(row);
  }
  return notes.length ? notes : null;
}

function hasWork(lines: PriceLine[], table: Table, data: Inspection): boolean {
  const sources = new Map(table.items.map((item) => [item.item_id, item.quantity_source]));
  const entered = data.scopeItems ?? {};
  return lines.some((line) => {
    if (line.itemId === null || !sources.has(line.itemId)) return true;
    const source = sources.get(line.itemId) ?? '';
    if (source.startsWith('typed')) return Object.hasOwn(entered, line.itemId) && line.group !== 'job_charges';
    return !BASELINE_SOURCES.has(source);
  });
}

function claimReference(claim: Claim): string[] {
  const loss = claim.date_of_loss;
  const formatted = loss ? `${loss.slice(5, 7)}-${loss.slice(8, 10)}-${loss.slice(0, 4)}` : '';
  const rows: Array<[string, string]> = [
    ['Claim number', claim.claim_number],
    ['Policy number', claim.policy_number],
    ['Date of loss', formatted],
    ['Cause and source of loss', claim.loss_cause],
    ['Deductible', claim.deductible],
  ];
  return rows.flatMap(([label, value]) => (value ? [`${label}: ${value}`] : []));
}

function addressee(claim: Claim | null): string {
  const name = claim?.adjuster_name ?? '';
  const contact = [claim?.adjuster_email, claim?.adjuster_phone].filter((value) => value).join(' · ');
  return ['TO: ' + (name ? `${name}, Adjuster` : 'Insurance Claims Examiner / Adjuster'), claim?.carrier ?? '', contact]
    .filter((value) => value)
    .join('\n');
}

function pricePointSentence(low: Dec, high: Dec | null): string {
  const amount = (value: Dec): string => `$${value.format(',.2f')}`;
  if (high === null) return low.isZero() ? '' : `Price-point adjustment (not taxed): ${amount(low)}.`;
  if (low.isZero() && high.isZero()) return '';
  return `Price-point adjustment (not taxed): ${amount(low)} at the low end and ${amount(high)} at the high end.`;
}

function adjustmentSentence(low: End, high: End | null): string {
  const text = (end: End): { adjustment?: AdjustmentText } => {
    const row = end.adjustment;
    return row
      ? { adjustment: { name: row.name, direction: row.direction, before: row.before.format('.2f'), amount: row.amount.format('.2f'), after: row.after.format('.2f') } }
      : {};
  };
  return adjustmentLines(text(low), high && text(high)).join('\n');
}

function estimateSentence(
  total: Dec,
  low: Dec,
  high: Dec | null,
  explanation: string | null,
  single: boolean,
  adjustment: string,
): string {
  const own = adjustment ? `\n${adjustment}` : '';
  if (single) return `Itemized total: $${total.format(',.2f')}.${own}`;
  const sentence = `Itemized total: $${total.format(',.2f')}. Customer estimate range: $${low.format(',.2f')} to $${(high ?? low).format(',.2f')}.`;
  return `${explanation ? `${sentence} ${explanation}` : sentence}${own}`;
}

function letterhead(parts: string[]): string {
  return parts
    .map((part) => oneLine(part.replaceAll('•', '·')))
    .filter((part) => part.trim())
    .join(' · ');
}

export function makeDocuments(input: {
  data: Inspection;
  photos: Json[];
  ai: Json;
  identity: Json | null;
  customerName: string;
  claim: Json | null;
  table: Table;
  /** The company's layout and its own clauses (S5a-9b); absent means the itemized layout, no clauses. */
  settings?: Json;
  /** Each room's findings note and prep tasks, in the record's room order (S5a-10); absent means none. */
  rooms?: Json[];
  /** The id of the named adjustment approved on the job, applied after price-point rounding (S5b-7). */
  adjustment?: string;
}): JObj {
  const ai = parse(AI, input.ai, 'ai');
  const settings = parse(LAYOUT_SETTINGS, input.settings, 'settings');
  const roomWords = input.rooms === undefined ? null : parse(ROOM_WORDS, input.rooms, 'rooms');
  const photos = input.photos.map((photo) => photoOf(photo));
  const identity: Identity | null = input.identity === null ? null : parse(IDENTITY, input.identity, 'identity');
  const claim: Claim | null = input.claim === null ? null : parse(CLAIM, input.claim, 'claim');
  const data = input.data;
  const companyName = identity?.name ?? '';
  const clauseCompany = companyName.trim() || 'the contractor';
  const signing =
    identity?.authorization_text !== undefined && identity.payment_terms_text !== undefined
      ? { authorizationText: identity.authorization_text, paymentTermsText: identity.payment_terms_text }
      : undefined;
  const setup = identity ? companySetupMissing(identity, signing) : [];
  if (!data.address.trim() || data.yearBuilt === null || data.rooms.length === 0) {
    fail('Enter the address, year built and rooms before auditing.');
  }
  if (data.packagePrice !== null) fail('Update the app and clear the old package-tier selection before auditing.');
  const before = data.yearBuilt < 1978;
  const priced = priceAndRange(data, input.table, input.adjustment);
  const estimate = estimateOf(priced.totals, input.table);
  const items = priced.lines.map((line) => ({ ...line }));
  const total = money(priced.totals.low.total);
  const low = total;
  const high = priced.totals.high ? money(priced.totals.high.total) : null;
  const single = priced.totals.mode === 'single';
  const explanation = typeof estimate.explanation === 'string' ? estimate.explanation : null;
  const approved = data.extras.filter((extra) => extra.approval);
  const extraLines = items.filter((item) => item.group === 'extras');
  approved.forEach((extra, index) => {
    const line = extraLines[index];
    if (line) line.description = wording(extra, clauseCompany);
  });
  const covered = new Set(approved.map((extra) => extra.description));
  const unpriced = ai.unpriced_work.filter((note) => !covered.has(plain(note)));
  const pending = data.extras.filter((extra) => extra.approval === null).length;
  const age = before
    ? `Due to property age (${data.yearBuilt}), California State Law requires third-party lead and asbestos testing prior to destructive demolition.`
    : `The home was built in ${data.yearBuilt}. Therefore, no lead or asbestos testing is required prior to the start of work.`;
  const clauses = [
    ...(before ? [PRETEST] : []),
    EXCLUSIONS.replaceAll('{company}', () => clauseCompany),
    REPRICE,
    VALIDITY,
  ];
  const observations = [age];
  if (data.technicianNotes.trim()) observations.push(`Technician observations: ${data.technicianNotes.trim()}`);
  const statement = technicianStatement(data.technicianTranscript);
  if (statement) observations.push(`Technician walkthrough statement: ${statement}`);
  photos.forEach((photo, index) => {
    if (photo.status === 'verified' && photo.ocr) {
      observations.push(`Photo ${index + 1} (${photo.room}) — ${photo.ocr.meter_type}: ${photo.ocr.value}`);
    } else {
      observations.push(`Photo ${index + 1} (${photo.room}) — supporting photo; no verified meter reading.`);
    }
  });
  const mandated = [
    ...(before ? [TESTING] : []),
    PROTECTION.replaceAll('{company}', () => clauseCompany),
  ];
  const recommendations = [...mandated, ...items.filter((item) => item.group !== 'job_charges').map((item) => item.description), ADDITIONAL];
  const words = roomWordsFor(data.rooms, roomWords);
  const customer = input.customerName.trim();
  const license = identity?.license ?? '';
  const head = letterhead([
    companyName,
    identity?.address ?? '',
    identity?.phone ?? '',
    license.trim() ? `CSLB #${license}` : '',
  ]);
  const sizing = letterParagraph(equipmentSizing(data));
  const letter = [
    ...(head ? [head] : []),
    addressee(claim),
    [`RE: Remediation scope for ${data.address}`, ...(customer ? [`Customer: ${customer}`] : []), ...(claim ? claimReference(claim) : [])].join('\n'),
    'This scope describes proposed work; completion has not been recorded.',
    'The scope is prepared with reference to IICRC S500/S520 restoration practices. Project-specific conditions and evidence are recorded below; no unsupported section citation or completion claim is made.',
    observations.join('\n'),
    ...(sizing ? [sizing] : []),
    `Scope:\n${recommendations.join('\n')}`,
    clauses.join('\n'),
    estimateSentence(
      total,
      low,
      high,
      explanation,
      single,
      [
        pricePointSentence(
          money(priced.totals.low.pricePoint),
          priced.totals.mode === 'range' && priced.totals.high ? money(priced.totals.high.pricePoint) : null,
        ),
        adjustmentSentence(priced.totals.low, priced.totals.mode === 'range' ? priced.totals.high : null),
      ]
        .filter((text) => text)
        .join('\n'),
    ),
    ['Sincerely,', identity?.signoff ?? '', companyName].filter((line) => line.trim()).join('\n'),
  ].join('\n\n');
  const proposal: JObj = {
    customer_name: customer,
    disclaimers: [PHOTO_LOCATION_PRIVACY, ADDRESS_LOCATION_PRIVACY, ...clauses],
    estimate_mode: single ? 'single' : 'range',
    findings: observations,
    lead_notice_required: before,
    property_address: data.address,
    proposed_cost: (high ?? low).toString(),
    recommendations,
    ...layoutKeys(settings, () =>
      letterOf({ rooms: data.rooms, words, lines: items, table: input.table, findings: [age], recommendations: mandated, additional: ADDITIONAL }),
    ),
  };
  if (!single) proposal.proposed_cost_low = low.toString();
  const documents: JObj = {
    adr_estimate: proposal,
    ai_suggestions: [...ai.suggestions, ...(before ? ai.testing_advice : [])].map((note) => aiNote(note)).filter((note) => note),
    ai_summary: aiNote(ai.summary),
    company_setup_missing: setup,
    compliance_notes: [age, ...clauses],
    estimate,
    iicrc_defense_letter: letter,
    pending_extras: pending,
    photo_audit_log: photos.map((photo) => photo.row),
    schema_version: 3,
    signable:
      setup.length === 0 &&
      data.scopeConfirmed &&
      hasWork(items, input.table, data) &&
      unpriced.length === 0 &&
      pending === 0 &&
      !photos.some((photo) => photo.status === 'pending'),
    unpriced_work: unpriced.map((note) => plain(note)),
    xactimate_scope: items.map((item) => lineJson(item)),
    xactimate_total: total.toString(),
  };
  if (identity) documents.company_identity = identity;
  if (claim) documents.claim = claim;
  const notes = notesOf(data);
  if (notes) documents.quantity_notes = notes;
  return documents;
}
