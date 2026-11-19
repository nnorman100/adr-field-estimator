import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Proposal as ProposalView } from '@/app/(auth)/sign-in/[address]/jobs/[jobId]/review/review-documents';
import { priceEstimate, type Estimate, type Json } from '@/engine/estimate';
import { estimateInput } from '@/lib/estimates/inputs';
import { proposalBytes, proposalOf, type Proposal } from '@/lib/estimates/proposal';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments, type DocumentSettings } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';

// S5a-9b, the proposal layouts (docs/plans/S5.md): the itemized proposal (S5a-9's, the default) or
// one plain letter, the company's own clauses, and line prices shown or hidden by the price table's
// `show_line_breakdown`. Every case goes from a submitted record through the engine to the stored
// proposal bytes, the path the estimate route takes.

const hash = (digit: string) => digit.repeat(64);

// Three rooms: the hall and the kitchen have lines, the closet has none but a findings note.
function snapshot(yearBuilt = 1972): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    draftId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fieldSha256: hash('d'),
    field: {
      draft: { yearBuilt, roomOrder: ['hall', 'kitchen', 'closet'], summary: 'Category 2 water in the hall and kitchen.', scopeConfirmed: true, matterportScans: 1 },
      rooms: [
        {
          id: 'hall',
          field: {
            name: 'Hall',
            category: 2,
            floorSf: 40,
            wetFloorSf: 40,
            items: { flood_cut: '12.5' },
            prepTasks: ['The homeowner removes the rugs before the start date.'],
            findings: 'Baseboards swollen along the east wall.',
          },
        },
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, prepTasks: ['Clear the cabinet under the sink.'] } },
        { id: 'closet', field: { name: 'Closet', category: 2, findings: 'Musty odour; the materials read dry.' } },
      ],
      photos: [],
    },
    photos: [],
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0100', email: 'casey@example.invalid' },
    claim: {},
  };
}

const COMPANY: CompanyDocuments = {
  identity: {
    companyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'Valley Water Pros',
    address: '1 Synthetic Way, Testville',
    phone: '555-0199',
    email: 'office@example.invalid',
    license: '000002',
    signoff: 'Robin Example',
  },
  letterhead: NEUTRAL_LETTERHEAD,
  settings: NEUTRAL_SETTINGS,
  signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
};

// $2.00 a square foot of wet floor, a typed flood cut at $3.00 a foot and one whole-job scan.
function table(showLineBreakdown = false): Json {
  return {
    items: [
      { item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' },
      { item_id: 'flood_cut', group: 'demolition', name: '4 ft flood cut', unit: 'lf', quantity_source: 'room:typed', unit_price: '3.00' },
      { item_id: 'scan', group: 'optional_services', name: 'Matterport scan', unit: 'each', quantity_source: 'field:matterport_scans', unit_price: '150.00' },
    ],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      show_line_breakdown: showLineBreakdown,
    },
  };
}

const BASIS = { submission: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshotSha256: hash('a') }, version: { sequence: 3 } };

function priced(company: CompanyDocuments, record: Snapshot, showLineBreakdown: boolean): Estimate {
  const result = priceEstimate(table(showLineBreakdown), estimateInput(record, company).job);
  if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
  return result;
}

function proposal(company: CompanyDocuments = COMPANY, { yearBuilt = 1972, showLineBreakdown = false } = {}): Proposal {
  return proposalOf({ estimate: priced(company, snapshot(yearBuilt), showLineBreakdown), company, showLineBreakdown, ...BASIS });
}

describe('a company with no document settings', () => {
  it('gets proposal bytes identical to S5a-9’s itemized proposal', () => {
    // The SHA-256 of these bytes as S5a-9 (with S5a-11's signing texts) made them, before layouts existed.
    expect(proposalBytes(proposal()).sha256).toBe('faa73989cb799153a85a4586a5eb9c7d9475b0729619df9a60bf7bd613286661');
    expect(proposalBytes(proposal(COMPANY, { showLineBreakdown: true })).sha256).toBe('1259fd38cf1ea79ea5f47c862e26f10a93aeb2e70204df4648238a8970117f9d');
    expect(proposalBytes(proposal(COMPANY, { yearBuilt: 1990 })).sha256).toBe('42d95b49ccbb80433d5c40d298fd008e942835c1b600ce227d0614eeaf20e2e4');
  });
});

const LETTER: CompanyDocuments = { ...COMPANY, settings: { ...NEUTRAL_SETTINGS, proposalLayout: 'letter' } };
const AGE_1972 = 'Due to property age (1972), California State Law requires third-party lead and asbestos testing prior to destructive demolition.';
const AGE_1990 = 'The home was built in 1990. Therefore, no lead or asbestos testing is required prior to the start of work.';
const TESTING =
  "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly.";
const PROTECTION =
  'Per IICRC and EPA protocols, Valley Water Pros technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.';
const ADDITIONAL =
  'If technicians encounter additional affected building materials beyond the quantities previously described, the project manager will contact the property owner to discuss any additional course of action necessary and the associated cost.';
const PRIVACY = [
  "Photos taken during the inspection are stamped with the location reported by the technician's phone, when the technician allows it, and that location is part of the photo log.",
  'When the job address is entered, the typed address is sent to Google Maps to suggest matching addresses, and the selected location is saved with the job.',
];
const STANDARD = [
  'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of Valley Water Pros. This estimate does not include testing of any kind.',
  'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.',
  'Estimate is valid for 30 days from date of inspection.',
];
const PRETEST = '(this does not include the pretest for lead/asbestos)';

function withSettings(company: CompanyDocuments, settings: Partial<DocumentSettings>): CompanyDocuments {
  return { ...company, settings: { ...company.settings, ...settings } };
}

describe('the mandated clauses keep their exact text and conditions in both layouts', () => {
  it('built before 1978: the age finding, the testing and protective-equipment sentences, the pretest notice', () => {
    const itemized = proposal();
    expect(itemized.findings?.[0]).toBe(AGE_1972);
    expect(itemized.recommendations?.slice(0, 2)).toEqual([TESTING, PROTECTION]);
    expect(itemized.recommendations?.at(-1)).toBe(ADDITIONAL);
    expect(itemized.disclaimers).toEqual([...PRIVACY, PRETEST, ...STANDARD]);
    const letter = proposal(LETTER);
    expect(letter.letter?.findings).toEqual([AGE_1972]);
    expect(letter.letter?.recommendations).toEqual([TESTING, PROTECTION]);
    expect(letter.letter?.additional).toBe(ADDITIONAL);
    expect(letter.disclaimers).toEqual([...PRIVACY, PRETEST, ...STANDARD]);
    expect(letter.lead_notice_required).toBe(true);
  });

  it('built in 1978 or later: the age finding says so, with no testing sentence and no pretest notice', () => {
    const itemized = proposal(COMPANY, { yearBuilt: 1990 });
    expect(itemized.findings?.[0]).toBe(AGE_1990);
    expect(itemized.recommendations?.[0]).toBe(PROTECTION);
    expect(itemized.disclaimers).toEqual([...PRIVACY, ...STANDARD]);
    const letter = proposal(LETTER, { yearBuilt: 1990 });
    expect(letter.letter?.findings).toEqual([AGE_1990]);
    expect(letter.letter?.recommendations).toEqual([PROTECTION]);
    expect(letter.letter?.additional).toBe(ADDITIONAL);
    expect(letter.disclaimers).toEqual([...PRIVACY, ...STANDARD]);
    expect(letter.lead_notice_required).toBe(false);
  });

  it('the letter keeps the heading and the letterhead, and holds no itemized findings or scope list', () => {
    const letter = proposal(LETTER);
    expect(letter.heading).toBe('Valley Water Pros · Official proposal');
    expect(letter.letterhead).toEqual(proposal().letterhead);
    expect(letter).not.toHaveProperty('findings');
    expect(letter).not.toHaveProperty('recommendations');
  });
});

describe('the letter', () => {
  it('lists every room under Area inspected by name only, a room with no lines included', () => {
    expect(proposal(LETTER).letter?.area_inspected).toEqual(['Hall', 'Kitchen', 'Closet']);
  });

  it('puts each recorded findings note under Findings after the age sentence, a room with no lines included', () => {
    expect(proposal(LETTER).letter?.room_findings).toEqual([
      { room: 'Hall', text: 'Baseboards swollen along the east wall.' },
      { room: 'Closet', text: 'Musty odour; the materials read dry.' },
    ]);
  });

  it('prints each room’s prep tasks, marked with an asterisk, then its lines as “up to” quantities, under that room', () => {
    const letter = proposal(LETTER).letter!;
    expect(letter.room_work).toEqual([
      { room: 'Hall', prep_tasks: ['* The homeowner removes the rugs before the start date.'], lines: [{ text: '4 ft flood cut: up to 12.5 lf' }, { text: 'Extraction: up to 40 sf' }] },
      { room: 'Kitchen', prep_tasks: ['* Clear the cabinet under the sink.'], lines: [{ text: 'Extraction: up to 80 sf' }] },
    ]);
    // Work priced for the whole job, not for a room, follows the rooms.
    expect(letter.job_work).toEqual([{ text: 'Matterport scan: up to 1 each' }]);
  });

  it('the itemized layout prints no room findings note or prep task', () => {
    const text = proposalBytes(proposal()).bytes.toString('utf8');
    expect(text).not.toContain('Baseboards swollen');
    expect(text).not.toContain('Clear the cabinet');
  });
});

describe('line prices follow the price table’s show_line_breakdown', () => {
  it('off: the work is listed without prices and the total is still shown, in both layouts', () => {
    for (const company of [COMPANY, LETTER]) {
      const shown = proposal(company);
      expect(shown.price).not.toHaveProperty('lines');
      expect(shown.price.low.total).toBe('427.50');
      expect(JSON.stringify(shown.letter ?? {})).not.toContain('"total"');
    }
  });

  it('on: each line shows its price, in both layouts', () => {
    expect(proposal(COMPANY, { showLineBreakdown: true }).price.lines).toEqual([
      { description: 'Hall: 4 ft flood cut', quantity: '12.5', unit: 'lf', total: '37.50' },
      { description: 'Hall: Extraction', quantity: '40', unit: 'sf', total: '80.00' },
      { description: 'Kitchen: Extraction', quantity: '80', unit: 'sf', total: '160.00' },
      { description: 'Matterport scan', quantity: '1', unit: 'each', total: '150.00' },
    ]);
    const letter = proposal(LETTER, { showLineBreakdown: true });
    expect(letter.letter?.room_work.map((room) => room.lines)).toEqual([
      [
        { text: '4 ft flood cut: up to 12.5 lf', total: '37.50' },
        { text: 'Extraction: up to 40 sf', total: '80.00' },
      ],
      [{ text: 'Extraction: up to 80 sf', total: '160.00' }],
    ]);
    expect(letter.letter?.job_work).toEqual([{ text: 'Matterport scan: up to 1 each', total: '150.00' }]);
    // The letter's lines carry the prices; the price is its one price line.
    expect(letter.price).not.toHaveProperty('lines');
    expect(letter.price.low.total).toBe('427.50');
  });

  it('the letter lists a priced job charge like any other line, with its price only when the breakdown is on', () => {
    const SERVICE_CALL = { item_id: 'service_call', group: 'job_charges', name: 'Emergency service call', unit: 'each', quantity_source: 'field:emergency_calls', unit_price: '150.00' };
    const letterWith = (showLineBreakdown: boolean): Proposal => {
      const base = table(showLineBreakdown) as { items: Json[]; policy: Json };
      const result = priceEstimate({ ...base, items: [...base.items, SERVICE_CALL] }, estimateInput(snapshot(), LETTER).job);
      if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
      return proposalOf({ estimate: result, company: LETTER, showLineBreakdown, ...BASIS });
    };
    const off = letterWith(false);
    expect(off.price.low.total).toBe('577.50');
    expect(off.letter?.job_work).toEqual([{ text: 'Emergency service call: up to 1 each' }, { text: 'Matterport scan: up to 1 each' }]);
    const on = letterWith(true);
    expect(on.letter?.job_work).toEqual([
      { text: 'Emergency service call: up to 1 each', total: '150.00' },
      { text: 'Matterport scan: up to 1 each', total: '150.00' },
    ]);
    const listed = [...on.letter!.room_work.flatMap((room) => room.lines), ...on.letter!.job_work].reduce((sum, line) => sum + Number(line.total), 0);
    expect(listed.toFixed(2)).toBe(on.price.low.subtotal);
  });

  it('the itemized claim always shows each line’s price', () => {
    const estimate = priced(LETTER, snapshot(), false);
    expect(estimate.documents!.itemized_claim.map((line) => (line as { total: string }).total)).toEqual(['37.50', '80.00', '160.00', '150.00']);
  });
});

describe('the company’s own clauses', () => {
  const CLAUSES = [
    { title: '  Scheduling ', text: '  We confirm the start date by phone.\n\nTwo days before.\n' },
    { title: 'Access', text: 'Keys are returned at the end of each day.' },
  ];

  it('print exactly as entered, in both layouts, and every standard clause is still there', () => {
    for (const company of [COMPANY, LETTER]) {
      const without = proposal(company);
      const withClauses = proposal(withSettings(company, { companyClauses: CLAUSES }));
      expect(withClauses.company_clauses).toEqual(CLAUSES);
      // Added text only: nothing mandated is replaced, reordered or removed.
      const { company_clauses: added, ...rest } = withClauses;
      expect(added).toEqual(CLAUSES);
      expect(rest).toEqual(without);
      expect(without).not.toHaveProperty('company_clauses');
    }
  });
});

describe('one company’s settings never reach another company’s documents', () => {
  it('a company with no settings gets the same bytes after another company prints its letter and clauses', () => {
    const other: CompanyDocuments = {
      ...LETTER,
      identity: { ...LETTER.identity, companyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Other Restoration' },
      letterhead: { ...NEUTRAL_LETTERHEAD, tagline: 'Other tagline', emergencyPhone: '555-0911' },
      settings: { ...LETTER.settings, companyClauses: [{ title: 'Other', text: 'Other company wording.' }] },
    };
    const text = proposalBytes(proposal(other)).bytes.toString('utf8');
    expect(text).toContain('Other company wording.');
    expect(text).toContain('Emergency: 555-0911');
    expect(proposalBytes(proposal()).sha256).toBe('faa73989cb799153a85a4586a5eb9c7d9475b0729619df9a60bf7bd613286661');
    expect(NEUTRAL_SETTINGS).toEqual({ proposalLayout: 'itemized', companyClauses: [], photoLogGrouping: 'room' });
  });
});

describe('the letter proposal with a price-point adjustment (S4-4e)', () => {
  // Work $240.00 + $37.50 + $150.00 = $427.50; 10% tax = $42.75; $470.25 rounds up to $499.00 (step 100, ending 99): $28.75.
  function rounded(showLineBreakdown: boolean): { proposal: Proposal; html: string } {
    const base = table(showLineBreakdown) as { items: Array<Record<string, Json>>; policy: Record<string, Json> };
    const priceTable = { ...base, items: base.items.map((row) => ({ ...row, taxable: true })), policy: { ...base.policy, sales_tax: { enabled: true, percent: '10' }, price_point: { step: '100', ending: '99' } } };
    const result = priceEstimate(priceTable as Json, estimateInput(snapshot(1990), LETTER).job);
    if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
    const letter = proposalOf({ estimate: result, company: LETTER, showLineBreakdown, ...BASIS });
    return { proposal: letter, html: renderToStaticMarkup(createElement(ProposalView, { proposal: letter as never })) };
  }

  it('with line prices shown, prints the stored charge rows so the lines add up to the total', () => {
    const { proposal: letter, html } = rounded(true);
    expect(letter.price.low).toMatchObject({ subtotal: '427.50', tax: '42.75', price_point: '28.75', total: '499.00' });
    expect(html).toContain('Subtotal');
    expect(html).toContain('Sales tax');
    expect(html).toContain('$42.75');
    expect(html).toContain('Price-point adjustment (not taxed): $28.75');
    expect(html).toContain('Price: $499.00');
  });

  it('with line prices hidden, prints the price and the adjustment without charge rows', () => {
    const { html } = rounded(false);
    expect(html).not.toContain('Sales tax');
    expect(html).toContain('Price-point adjustment (not taxed): $28.75');
  });
});
