// The four claim documents. Prices and required sentences come from the engine, never from a model.

import { Dec, HUNDRED, money, percentText } from './decimal';
import type { JObj, JVal } from './json';
import { JFloat, JInt, jfloat, jint, pyFloat } from './json';
import type { Inspection } from './inspection';
import { letterParagraph, equipmentSizing } from './sizing';
import { V2 } from './table';
import { aiNote, plain, technicianStatement } from './text';
import { BASELINE_SOURCES, SCOPE_EXCLUDED, V1, priceScopeV1, proposalRange } from './price-v1';
import { priceAndRange, type End, type Totals } from './totals';
import { documentLine, floatMoney, has, isObj, oneLine, type PriceLine } from './values';
import type { JobPin } from './pin';

const PROPOSAL_DATE = '11-06-2026';
const ZERO_TOTAL = 'The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing.';
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

function fail(message: string): never {
  throw new Error(message);
}

function textOf(value: JVal | undefined, max: number): string {
  if (typeof value !== 'string' || value.length > max) fail('text');
  return value;
}

function identityOf(value: JVal | null): JObj | null {
  if (value === null) return null;
  if (!isObj(value)) fail('identity');
  const allowed = new Set([
    'company_id',
    'version',
    'name',
    'address',
    'phone',
    'email',
    'license',
    'signoff',
    'logo_data_url',
    'water_heater_notice',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`identity ${key}`);
  const version = value.version;
  if (!(version instanceof JInt) || version.value < 1) fail('identity version');
  return {
    address: textOf(value.address, 500),
    company_id: textOf(value.company_id, 128),
    email: textOf(value.email, 254),
    license: textOf(value.license, 80),
    logo_data_url: typeof value.logo_data_url === 'string' ? value.logo_data_url : '',
    name: textOf(value.name, 200),
    phone: textOf(value.phone, 80),
    signoff: textOf(value.signoff, 200),
    version: jint(version.value),
    water_heater_notice: typeof value.water_heater_notice === 'string' ? value.water_heater_notice : '',
  };
}

function claimLine(value: JVal | undefined, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) fail('claim');
  const text = oneLine(value);
  if (text.length > max) fail('claim');
  return text;
}

function claimEmail(value: JVal | undefined): string {
  const text = claimLine(value, 254).toLowerCase();
  if (text && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) fail('claim email');
  return text;
}

function claimDate(value: JVal | undefined): string {
  const text = claimLine(value, 10);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('claim date');
  const [year, month, day] = text.split('-').map((part) => Number(part));
  const loss = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const today = new Date();
  const limit = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (loss > limit) fail('claim date');
  return text;
}

function claimOf(value: JVal | null): JObj | null {
  if (value === null) return null;
  if (!isObj(value)) fail('claim');
  const allowed = new Set([
    'carrier',
    'claim_number',
    'policy_number',
    'date_of_loss',
    'loss_cause',
    'adjuster_name',
    'adjuster_email',
    'adjuster_phone',
    'deductible',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`claim ${key}`);
  return {
    adjuster_email: claimEmail(value.adjuster_email),
    adjuster_name: claimLine(value.adjuster_name, 150),
    adjuster_phone: claimLine(value.adjuster_phone, 80),
    carrier: claimLine(value.carrier, 150),
    claim_number: claimLine(value.claim_number, 80),
    date_of_loss: claimDate(value.date_of_loss),
    deductible: claimLine(value.deductible, 40),
    loss_cause: claimLine(value.loss_cause, 500),
    policy_number: claimLine(value.policy_number, 80),
  };
}

function aiOf(value: JVal): { summary: string; suggestions: string[]; unpriced: string[]; testing: string[] } {
  if (!isObj(value)) fail('ai');
  const allowed = new Set(['summary', 'suggestions', 'unpriced_work', 'testing_advice']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`ai ${key}`);
  const summary = value.summary;
  if (typeof summary !== 'string' || summary.length < 1 || summary.length > 6000) fail('ai summary');
  const list = (key: string, max: number, itemMax: number, required: boolean): string[] => {
    const raw = value[key];
    if (raw === undefined && !required) return [];
    if (!Array.isArray(raw) || raw.length > max) fail(key);
    return raw.map((item) => {
      if (typeof item !== 'string' || item.length > itemMax) fail(key);
      return item;
    });
  };
  return {
    summary,
    suggestions: list('suggestions', 30, 1000, true),
    unpriced: list('unpriced_work', 30, 1000, true),
    testing: list('testing_advice', 10, 1000, false),
  };
}

function numberOf(value: JVal | undefined, label: string): JVal {
  if (value instanceof JInt || value instanceof JFloat) return value;
  if (typeof value === 'number') return jfloat(value);
  fail(label);
}

function locationOf(value: JVal): JObj {
  if (!isObj(value)) fail('location');
  const source = value.source;
  if (source !== 'device' && source !== 'not_available' && source !== 'not_shared') fail('location');
  const present = (key: string) => has(value, key) && value[key] != null;
  if (source === 'device') {
    if (!present('latitude') || !present('longitude') || !present('accuracy_m')) fail('location');
    return {
      accuracy_m: numberOf(value.accuracy_m, 'location'),
      latitude: numberOf(value.latitude, 'location'),
      longitude: numberOf(value.longitude, 'location'),
      source,
    };
  }
  if (present('latitude') || present('longitude') || present('accuracy_m')) fail('location');
  return { source };
}

function photoLog(photos: JVal[]): JObj[] {
  return photos.map((photo) => {
    if (!isObj(photo)) fail('photo');
    const status = photo.ocr_status;
    if (status !== 'pending' && status !== 'verified' && status !== 'no_meter' && status !== 'failed') fail('photo');
    if (typeof photo.id !== 'string' || typeof photo.room !== 'string' || typeof photo.captured_at !== 'string') fail('photo');
    const row: JObj = {
      captured_at: photo.captured_at,
      height: numberOf(photo.height, 'photo'),
      id: photo.id,
      ocr_status: status,
      room: photo.room,
      width: numberOf(photo.width, 'photo'),
    };
    if (photo.ocr != null) row.ocr = photo.ocr;
    if (photo.location != null) row.location = locationOf(photo.location);
    return row;
  });
}

function endFloats(end: End): JObj {
  const num = (value: Dec) => jfloat(money(value).toNumber());
  return {
    after_hours: num(end.afterHours),
    minimum_charge: num(end.minimumCharge),
    overhead_profit: num(end.overheadProfit),
    subtotal: num(end.subtotal),
    tax: num(end.tax),
    total: num(end.total),
  };
}

function estimateOf(totals: Totals, policyMultiplier: string, overhead: string, tax: { enabled: boolean; percent: string }, show: boolean): JObj {
  const multiplier = Dec.parse(policyMultiplier);
  const body: JObj = {
    after_hours_label: totals.afterHoursLabel,
    after_hours_percent: percentText(multiplier.sub(Dec.fromInt(1)).mul(HUNDRED)),
    low: endFloats(totals.low),
    mode: totals.mode,
    overhead_profit_percent: percentText(overhead),
    sales_tax_percent: tax.enabled ? percentText(tax.percent) : '0',
    show_line_breakdown: show,
  };
  if (totals.mode === 'range' && totals.high) body.high = endFloats(totals.high);
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
    const key = room.name.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    if (!rooms.has(key)) rooms.set(key, room.name);
  }
  const notes: JObj[] = [];
  for (const [key, override] of Object.entries(data.quantityOverrides ?? {})) {
    const split = key.lastIndexOf(':');
    const name = split >= 0 ? key.slice(0, split) : '';
    const field = split >= 0 ? key.slice(split + 1) : key;
    const room = rooms.get(name.split(/\s+/).filter(Boolean).join(' ').toLowerCase());
    const label = room ? ROOM_LABELS[field] : JOB_LABELS[key];
    if (!label || override.measured.eq(override.entered)) continue;
    const row: JObj = {
      entered: jfloat(override.entered.toNumber()),
      label,
      measured: jfloat(override.measured.toNumber()),
      reason: override.reason ?? '',
    };
    if (room) row.room = room;
    notes.push(row);
  }
  return notes.length ? notes : null;
}

function hasWork(lines: PriceLine[], pin: JobPin, data: Inspection): boolean {
  const sources = new Map((pin.items ?? []).map((item) => [item.itemId, item.quantitySource]));
  const entered = data.scopeItems ?? {};
  return lines.some((line) => {
    if (line.itemId == null || !sources.has(line.itemId)) return true;
    const source = sources.get(line.itemId) ?? '';
    if (source.startsWith('typed')) return Object.prototype.hasOwnProperty.call(entered, line.itemId) && line.group !== 'job_charges';
    return !BASELINE_SOURCES.has(source);
  });
}

function v1Work(data: Inspection): boolean {
  return (
    data.rooms.some((room) => room.unfinishedSf || room.finishedSf) ||
    Boolean(data.airMovers || data.dehumidifiers || data.woodFloorSystems || data.laborHours) ||
    data.extras.some((extra) => extra.approval) ||
    Boolean(data.matterportScans || data.dumpTruckLoads || data.equipmentDecon || data.powerDistribution)
  );
}

function claimReference(claim: JObj): string[] {
  const loss = typeof claim.date_of_loss === 'string' && claim.date_of_loss ? claim.date_of_loss : '';
  const formatted = loss ? `${loss.slice(5, 7)}-${loss.slice(8, 10)}-${loss.slice(0, 4)}` : '';
  const rows: Array<[string, JVal | undefined]> = [
    ['Claim number', claim.claim_number],
    ['Policy number', claim.policy_number],
    ['Date of loss', formatted],
    ['Cause and source of loss', claim.loss_cause],
    ['Deductible', claim.deductible],
  ];
  return rows.flatMap(([label, value]) => (typeof value === 'string' && value ? [`${label}: ${value}`] : []));
}

function addressee(claim: JObj): string {
  const name = typeof claim.adjuster_name === 'string' ? claim.adjuster_name : '';
  const carrier = typeof claim.carrier === 'string' ? claim.carrier : '';
  const contact = [claim.adjuster_email, claim.adjuster_phone].filter((value) => typeof value === 'string' && value).join(' \u00b7 ');
  return ['TO: ' + (name ? `${name}, Adjuster` : 'Insurance Claims Examiner / Adjuster'), carrier, contact]
    .filter((value) => value.trim())
    .join('\n');
}

function estimateSentence(v2: boolean, total: number, low: Dec, high: Dec | null, items: PriceLine[], explanation: string | null, single: boolean): string {
  if (!v2) {
    const extra = items.some((item) => item.code === 'ADR-EXTRA');
    return (
      `Itemized charges at base rates: $${floatMoney(total)}. Customer estimate range: $${low.format(',.2f')} to $${(high ?? low).format(',.2f')}. The range applies the estimating sheet labor/material allowance to the priced scope` +
      (extra ? '; approved additional work is added at its approved amount to both ends.' : '.')
    );
  }
  if (single) return `Itemized total: $${floatMoney(total)}.`;
  const sentence = `Itemized total: $${floatMoney(total)}. Customer estimate range: $${low.format(',.2f')} to $${(high ?? low).format(',.2f')}.`;
  return explanation ? `${sentence} ${explanation}` : sentence;
}

function letterhead(parts: string[]): string {
  return parts
    .map((part) => part.replaceAll('\u2022', '\u00b7'))
    .map((part) => part.split(/\s+/).filter(Boolean).join(' '))
    .filter((part) => part.trim())
    .join(' \u00b7 ');
}

export function makeDocuments(input: {
  data: Inspection;
  photos: JVal[];
  ai: JVal;
  identity: JVal | null;
  customerName: string;
  claim: JVal | null;
  rates: Record<string, string> | null;
  basis: JObj | null;
  pin: JobPin | null;
}): JObj {
  const ai = aiOf(input.ai);
  const identity = identityOf(input.identity);
  const claim = claimOf(input.claim);
  const data = input.data;
  const companyName = typeof identity?.name === 'string' ? identity.name : '';
  const companyAddress = typeof identity?.address === 'string' ? identity.address : '';
  const companyLicense = typeof identity?.license === 'string' ? identity.license : '';
  const companyPhone = typeof identity?.phone === 'string' ? identity.phone : '';
  const signoff = typeof identity?.signoff === 'string' ? identity.signoff : '';
  const clauseCompany = companyName.trim() || 'the contractor';
  const setup = identity
    ? (
        [
          ['name', 'Company name'],
          ['address', 'Company address'],
          ['license', 'CSLB license'],
          ['signoff', 'Document sign-off'],
        ] as const
      ).flatMap(([key, label]) => {
        const field = identity[key];
        return typeof field === 'string' && field.trim() ? [] : [label];
      })
    : [];
  if (!data.address.trim() || data.yearBuilt === null || data.rooms.length === 0) {
    fail('Enter the address, year built and rooms before auditing.');
  }
  if (data.packagePrice !== null) fail('Update the app and clear the old package-tier selection before auditing.');
  const before = data.yearBuilt < 1978;
  let items: PriceLine[];
  let total: number;
  let low: Dec;
  let high: Dec | null;
  let estimate: JObj | null = null;
  let single = false;
  let explanation: string | null = null;
  if (input.pin?.calculationVersion === V2 && input.pin.policy) {
    const priced = priceAndRange(data, input.pin);
    if (!priced.totals) fail('The saved price table did not produce an estimate.');
    estimate = estimateOf(
      priced.totals,
      input.pin.policy.afterHours.multiplier,
      input.pin.policy.overheadProfitPercent,
      input.pin.policy.salesTax,
      input.pin.policy.showLineBreakdown,
    );
    items = priced.lines.map((line) => ({ ...line }));
    total = money(priced.totals.low.total).toNumber();
    low = Dec.parse(pyFloat(total));
    const highTotal = priced.totals.high ? money(priced.totals.high.total).toNumber() : null;
    high = highTotal === null ? null : Dec.parse(pyFloat(highTotal));
    single = priced.totals.mode === 'single';
    explanation = typeof estimate.explanation === 'string' ? estimate.explanation : null;
  } else if (input.basis?.calculation_version === V2) {
    fail('The saved price table is required to build these documents.');
  } else {
    const version = typeof input.basis?.calculation_version === 'string' ? input.basis.calculation_version : V1;
    if (version !== V1 || !input.rates) fail('Company prices are required to price this job.');
    const scoped = priceScopeV1(data, input.rates);
    const range = proposalRange(data, scoped.lines);
    items = scoped.lines;
    total = scoped.itemized;
    low = range.low;
    high = range.high;
    if (total <= 0) fail(ZERO_TOTAL);
  }
  const approved = data.extras.filter((extra) => extra.approval);
  const extraLines = items.filter((item) => (estimate ? item.group === 'extras' : item.code === 'ADR-EXTRA'));
  approved.forEach((extra, index) => {
    const line = extraLines[index];
    if (line) line.description = wording(extra, clauseCompany);
  });
  const covered = new Set(approved.map((extra) => extra.description));
  const unpriced = ai.unpriced.filter((text) => !covered.has(plain(text)));
  const pending = data.extras.filter((extra) => extra.approval === null).length;
  const age = before
    ? `Due to property age (${data.yearBuilt}), California State Law requires third-party lead and asbestos testing prior to destructive demolition.`
    : `The home was built in ${data.yearBuilt}. Therefore, no lead or asbestos testing is required prior to the start of work.`;
  const clauses = [...(before ? [PRETEST] : []), EXCLUSIONS.replaceAll('{company}', clauseCompany), REPRICE, VALIDITY];
  const observations = [age];
  if (data.technicianNotes.trim()) observations.push(`Technician observations: ${data.technicianNotes.trim()}`);
  const statement = technicianStatement(data.technicianTranscript);
  if (statement) observations.push(`Technician walkthrough statement: ${statement}`);
  input.photos.forEach((photo, index) => {
    if (!isObj(photo)) return;
    const room = typeof photo.room === 'string' ? photo.room : '';
    if (photo.ocr_status === 'verified' && isObj(photo.ocr)) {
      observations.push(`Photo ${index + 1} (${room}) \u2014 ${String(photo.ocr.meter_type)}: ${String(photo.ocr.value)}`);
    } else {
      observations.push(`Photo ${index + 1} (${room}) \u2014 supporting photo; no verified meter reading.`);
    }
  });
  const recommendations = [
    ...(before ? [TESTING] : []),
    PROTECTION.replaceAll('{company}', clauseCompany),
    ...items.filter((item) => (estimate ? item.group !== 'job_charges' : !SCOPE_EXCLUDED.has(item.code))).map((item) => item.description),
    ADDITIONAL,
  ];
  const customer = input.customerName.trim();
  const head = letterhead([
    companyName,
    companyAddress,
    companyPhone,
    companyLicense.trim() ? `CSLB #${companyLicense}` : '',
  ]);
  const sizing = letterParagraph(equipmentSizing(data));
  const claimRows = claimReference(claim ?? {});
  const letter = [
    ...(head ? [head] : []),
    addressee(claim ?? {}),
    [`RE: Remediation scope for ${data.address}`, ...(customer ? [`Customer: ${customer}`] : []), ...claimRows].join('\n'),
    'This scope describes proposed work; completion has not been recorded.',
    'The scope is prepared with reference to IICRC S500/S520 restoration practices. Project-specific conditions and evidence are recorded below; no unsupported section citation or completion claim is made.',
    observations.join('\n'),
    ...(sizing ? [sizing] : []),
    `Scope:\n${recommendations.join('\n')}`,
    clauses.join('\n'),
    estimateSentence(Boolean(estimate), total, low, high, items, explanation, single),
    ['Sincerely,', signoff, companyName].filter((line) => line.trim()).join('\n'),
  ].join('\n\n');
  const worked = estimate && input.pin ? hasWork(items, input.pin, data) : v1Work(data);
  const proposed = high ? jfloat(high.toNumber()) : jfloat(low.toNumber());
  const adr: JObj = {
    customer_name: customer,
    date: PROPOSAL_DATE,
    disclaimers: [PHOTO_LOCATION_PRIVACY, ADDRESS_LOCATION_PRIVACY, ...clauses],
    findings: observations,
    lead_notice_required: before,
    property_address: data.address,
    proposed_cost: proposed,
    recommendations,
  };
  if (!(estimate && single)) adr.proposed_cost_low = jfloat(low.toNumber());
  if (estimate) adr.estimate_mode = single ? 'single' : 'range';
  const documents: JObj = {
    adr_estimate: adr,
    ai_suggestions: [...ai.suggestions, ...(before ? ai.testing : [])].map((note) => aiNote(note)).filter((note) => note),
    ai_summary: aiNote(ai.summary),
    company_setup_missing: setup,
    compliance_notes: [age, ...clauses],
    iicrc_defense_letter: letter,
    pending_extras: jint(pending),
    photo_audit_log: photoLog(input.photos),
    schema_version: jint(3),
    signable: setup.length === 0 && data.scopeConfirmed && worked && unpriced.length === 0 && pending === 0 && !input.photos.some((photo) => isObj(photo) && photo.ocr_status === 'pending'),
    unpriced_work: unpriced.map((text) => plain(text)),
    xactimate_scope: items.map((item) => documentLine(item, Boolean(estimate))),
    xactimate_total: jfloat(total),
  };
  if (identity) documents.company_identity = identity;
  if (claim) documents.claim = claim;
  if (input.basis) documents.price_basis = input.basis;
  if (estimate) documents.estimate = estimate;
  const notes = estimate ? notesOf(data) : null;
  if (notes) documents.quantity_notes = notes;
  return documents;
}
