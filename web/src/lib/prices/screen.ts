import type { Item, PriceBand, PriceRow, Table } from '@/engine/table';
import { pickPriceRow } from '@/engine/row-pick';
import { CATEGORIES, OTHER_TYPE, SIZE_TIERS, categoryLabel, type Category, type SizeTier } from '@/engine/values';

// What the Prices screen (S4-8) decides in the browser, as pure functions so they are unit-tested.
// Everything here is convenience: the server checks the sign-in, the company, the price_books flag
// and the role again on every call (src/lib/prices/http.ts) and parses every table it is sent, so a
// wrong answer here shows the wrong screen but never grants or prices anything. Nothing here
// computes a price: amounts are shown as the owner typed them, and every total comes from the
// server's preview. Words come from fixed codes only; nothing the person typed goes into a message.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A table as the server sends it (already parsed there): items and policy present.
export function tableOf(value: unknown): Table | null {
  if (!isObject(value) || !Array.isArray(value.items) || !isObject(value.policy)) return null;
  if (!value.items.every((item) => isObject(item) && typeof item.item_id === 'string')) return null;
  return value as unknown as Table;
}

export type WorkingCopy = { revision: number; baseSequence: number | null; updatedAt: string | null; table: Table };
export type CurrentVersion = { id: string; sequence: number; publishedAt: string; table: Table };
export type OwnerPrices = { view: 'owner'; current: CurrentVersion | null; workingCopy: WorkingCopy };
export type ReaderPrices = { view: 'reader'; current: CurrentVersion | null };

const revisionOk = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function workingCopyOf(value: unknown): WorkingCopy | null {
  const table = tableOf(field(value, 'table'));
  const revision = field(value, 'revision');
  const baseSequence = field(value, 'baseSequence');
  const updatedAt = field(value, 'updatedAt');
  if (!table || !revisionOk(revision)) return null;
  if (baseSequence !== null && !revisionOk(baseSequence)) return null;
  if (updatedAt !== null && typeof updatedAt !== 'string') return null;
  return { revision, baseSequence, updatedAt, table };
}

function currentOf(value: unknown): CurrentVersion | null | undefined {
  if (value === null) return null;
  const table = tableOf(field(value, 'table'));
  const [id, sequence, publishedAt] = ['id', 'sequence', 'publishedAt'].map((key) => field(value, key));
  if (!table || typeof id !== 'string' || !revisionOk(sequence) || typeof publishedAt !== 'string') return undefined;
  return { id, sequence, publishedAt, table };
}

// GET /api/prices's answer, or null when it is not the shape the server sends.
export function pricesView(body: unknown): OwnerPrices | ReaderPrices | null {
  const current = currentOf(field(body, 'current'));
  if (current === undefined) return null;
  if (field(body, 'view') === 'reader') return { view: 'reader', current };
  if (field(body, 'view') !== 'owner') return null;
  const workingCopy = workingCopyOf(field(body, 'workingCopy'));
  return workingCopy ? { view: 'owner', current, workingCopy } : null;
}

// GET /api/me's answer as what the Prices screen needs: whether the company's prices are open to
// this role at all (prices_read exists only while the price_books flag is on), and whether the role
// may change them (prices_manage, the owner's key).
export type PricesAccess = { companyId: string; canRead: boolean; canManage: boolean };

export function pricesAccess(body: unknown): PricesAccess | null {
  const companyId = field(field(body, 'company'), 'id');
  const capabilities = field(body, 'capabilities');
  if (typeof companyId !== 'string' || !Array.isArray(capabilities)) return null;
  return {
    companyId,
    canRead: capabilities.includes('prices_read'),
    canManage: capabilities.includes('prices_manage'),
  };
}

const MESSAGES: Record<string, string> = {
  not_allowed: 'Only the company owner can change the prices.',
  not_found: 'That price version could not be found. Reload the page.',
  stale_revision:
    'The prices were changed on another device since this screen opened. Reload to see them; the changes made here are not saved.',
  conflict: 'Another change was being saved at the same moment. Try again.',
  publish_key_used: 'That publish was already sent with another reason. Reload the page and publish again.',
  no_changes: 'Nothing has changed since the last published version, so there is nothing to publish.',
  invalid_table: 'Something in the prices cannot be saved.',
  invalid_import: 'The price list file could not be used. Nothing was changed.',
  not_publishable: 'The prices cannot be published yet.',
  range_choice_required: 'Choose how estimates show the price before the first publish.',
  table_unreadable: 'The saved prices could not be read. Contact DryScope support.',
  sign_in_again: 'Publishing needs a sign-in from the last 15 minutes. Sign in again, then publish.',
  invalid_request: 'Check the entries and try again.',
};

// A sentence for a refused prices call, with the server's detail (ids and rules, never a value it
// holds) after it, naming the item by its name where the detail starts with its place in the list.
export function pricesMessage(status: number, body: unknown, table?: Table): string {
  const code = field(body, 'error');
  const base =
    (typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined) ??
    (status === 0 || status >= 500
      ? 'We could not reach DryScope. Check your connection and try again.'
      : 'That did not work. Reload the page and try again.');
  const detail = field(body, 'detail');
  return typeof detail === 'string' ? `${base} ${readableDetail(detail, table)}` : base;
}

export function needsFreshSignIn(status: number, body: unknown): boolean {
  return status === 401 && field(body, 'error') === 'sign_in_again';
}

// The server's or the engine's sentence about the table, with the item named by its name.
export function readableDetail(detail: string, table?: Table): string {
  const place = /^items\.(\d+)(?:\.[^:]*)?: (.*)$/.exec(detail);
  const item = place && table ? table.items[Number(place[1])] : undefined;
  if (item && place) return `${item.name}: ${place[2]}.`;
  const byId = /^([a-z][a-z0-9_]{1,39}): (.*)$/.exec(detail);
  const named = byId && table?.items.find((candidate) => candidate.item_id === byId[1]);
  if (named && byId) return `${named.name}: ${byId[2]}.`;
  return `(${detail})`;
}

// "$1,234.50" for a price string as the table holds it, "Price not set" for a blank one. Only
// punctuation is added: the digits are the ones typed.
export function moneyText(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return 'Price not set';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const whole = match[1]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (match[2] ?? '').padEnd(2, '0');
  return `$${whole}.${cents}`;
}

const UNIT_WORDS: Record<string, string> = {
  sf: 'per sq ft',
  lf: 'per linear ft',
  each: 'each',
  hour: 'per hour',
  day: 'per day',
  unit_day: 'per unit per day',
  load: 'per load',
  visit: 'per visit',
  room: 'per room',
};

export function unitWords(unit: string): string {
  return UNIT_WORDS[unit] ?? unit;
}

export function categoryName(category: Category): string {
  return category === 'mold' ? 'Mold' : `Category ${category}`;
}

export function roomTypeName(table: Table, id: string | undefined): string {
  if (id === undefined) return '';
  return table.policy.room_types.find((type) => type.id === id)?.name ?? (id === OTHER_TYPE ? 'Other' : id);
}

// "Kitchen, Cat 3": a row's name, as the estimate's line names it.
export function rowName(table: Table, row: Pick<PriceRow, 'category' | 'room_type'>): string {
  return [row.room_type === undefined ? null : roomTypeName(table, row.room_type), row.category === undefined ? null : categoryLabel(row.category)]
    .filter(Boolean)
    .join(', ');
}

// Whether an item is priced room by room (a room quantity source): only those take price rows, and
// only those appear in "what does this room pay?".
// The fields an item's card lets the owner set, each only where the engine uses it: a default
// quantity for a typed item; for additional work, whose lines are each extra's own wording, hours
// and approved rate, no name, wording, waste, default quantity or Xactimate note; the after-hours
// flag for labor; the taxed share once tax applies.
export type ItemField =
  | 'name'
  | 'customer_description'
  | 'trade'
  | 'allow_zero'
  | 'waste_percent'
  | 'default_quantity'
  | 'taxable'
  | 'materials_share_percent'
  | 'after_hours'
  | 'no_overhead_profit'
  | 'xactimate_code';

const EXTRAS_GROUP = 'extras';
const AFTER_HOURS_GROUPS = new Set(['demolition', 'treatment', 'labor']);

export function itemFields(item: Item): ItemField[] {
  const extras = item.group === EXTRAS_GROUP;
  const fields: Array<ItemField | null> = [
    extras ? null : 'name',
    extras ? null : 'customer_description',
    'trade',
    'allow_zero',
    extras ? null : 'waste_percent',
    !extras && item.quantity_source === 'typed' ? 'default_quantity' : null,
    'taxable',
    item.taxable ? 'materials_share_percent' : null,
    AFTER_HOURS_GROUPS.has(item.group) ? 'after_hours' : null,
    'no_overhead_profit',
    extras ? null : 'xactimate_code',
  ];
  return fields.filter((field): field is ItemField => field !== null);
}

export function isRoomItem(item: Pick<Item, 'quantity_source'>): boolean {
  return item.quantity_source.startsWith('room:');
}

// The categories an item is used in: its filter, or all four when it names none.
export function itemCategories(item: Pick<Item, 'categories'>): Category[] {
  return item.categories.length ? [...item.categories] : [...CATEGORIES];
}

export type PriceShown =
  | { kind: 'single'; price: string }
  | { kind: 'tier'; tier: SizeTier; price: string }
  | { kind: 'brackets'; bands: PriceBand[] };

export type RoomPrice = {
  itemId: string;
  name: string;
  unit: string;
  // The row's name ("Kitchen, Cat 3") or null for the item's default price.
  row: string | null;
  price: PriceShown;
  // The water-category multiplier the default price is multiplied by in this room, when it is not 1.
  multiplier: string | null;
  // Rooms of this kind get the line only under these inputs (mold condition, affected area).
  conditions: string[];
};

export type RoomQuestion = { category: Category; roomType: string; tier: SizeTier };

const AFFECTED: Record<string, string> = {
  up_to_10: 'up to 10 sq ft affected',
  over_10_to_100: '10 to 100 sq ft affected',
  over_100: 'over 100 sq ft affected',
};

// "What does this room pay?": for a room of one category, room type and size, every item that is on
// and priced room by room, with the price row the engine would use (pickPriceRow, the engine's own
// rule) and that row's price as the owner set it. The multiplier is named, never applied here.
export function roomPrices(table: Table, question: RoomQuestion): RoomPrice[] {
  const byType = table.policy.room_type_pricing;
  const known = question.roomType === OTHER_TYPE || table.policy.room_types.some((type) => type.id === question.roomType);
  // As the engine resolves it (roomTypeOf): a type the table does not know matches no room-type row.
  const roomType = known ? question.roomType : null;
  return [...table.items]
    .filter((item) => item.enabled && isRoomItem(item) && itemCategories(item).includes(question.category))
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((item) => {
      // With "Price varies by room type" off, room-type rows are kept but never used (effectiveTable).
      const rows = byType ? item.rows : item.rows?.filter((row) => row.room_type === undefined);
      const row = pickPriceRow({ rows }, question.category, roomType);
      const tiers = row ? row.tier_prices : item.tier_prices;
      const bands = row ? row.price_brackets : item.price_brackets;
      const price: PriceShown = tiers
        ? { kind: 'tier', tier: question.tier, price: tiers[question.tier] }
        : bands
          ? { kind: 'brackets', bands }
          : { kind: 'single', price: (row ? row.unit_price : item.unit_price) ?? '' };
      const water = question.category !== 'mold' ? table.policy.category_multipliers[String(question.category) as '1' | '2' | '3'] : null;
      const conditions = [
        ...(item.mold_conditions?.length ? [`only for mold Condition ${item.mold_conditions.join(' or ')}`] : []),
        ...(item.affected_bands?.length ? [`only with ${item.affected_bands.map((band) => AFFECTED[band]).join(' or ')}`] : []),
      ];
      return {
        itemId: item.item_id,
        name: item.name,
        unit: item.unit,
        row: row ? rowName(table, row) : null,
        price,
        multiplier: !row && water !== null && water !== '1' ? water : null,
        conditions,
      };
    });
}

export const TIER_NAMES: Record<SizeTier, string> = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large' };
export { CATEGORIES, SIZE_TIERS, OTHER_TYPE };
