import type { Item, NamedAdjustment, PriceBand, PriceRow, Table, Trade } from '@/engine/table';
import { CATEGORIES, OTHER_TYPE, categoryOrder, chars, type Category, type SizeTier } from '@/engine/values';
import { itemCategories } from './screen';

// The Prices editor's changes to the working copy it has open, as pure functions so they are
// unit-tested. Each returns a new table and leaves the one it was given alone. They keep the table
// in the shape the schema (src/engine/table.ts) accepts where a click could break it (a row for a
// category the item no longer uses, a row for a removed room type); everything else, a price typed
// wrongly included, is the server's to refuse when the owner saves, with a sentence saying what.

export type TierPrices = Record<SizeTier, string>;
export type PriceForm = { unit_price?: string; price_brackets?: PriceBand[]; tier_prices?: TierPrices };

const BLANK_TIERS: TierPrices = { s: '', m: '', l: '', xl: '' };

export function updateItem(table: Table, itemId: string, change: (item: Item) => Item): Table {
  return { ...table, items: table.items.map((item) => (item.item_id === itemId ? change(item) : item)) };
}

// The item's own price, as a form: tier prices for a per-room item, its brackets, or one price.
export function defaultForm(item: Item): PriceForm {
  if (item.unit === 'room') return { tier_prices: item.tier_prices ?? { ...BLANK_TIERS } };
  if (item.price_brackets) return { price_brackets: item.price_brackets };
  return { unit_price: item.unit_price };
}

export function setDefaultForm(item: Item, form: PriceForm): Item {
  const { price_brackets: _bands, tier_prices: _tiers, ...rest } = item;
  void _bands;
  void _tiers;
  if (form.tier_prices) return { ...rest, unit_price: '', tier_prices: form.tier_prices };
  if (form.price_brackets) return { ...rest, unit_price: '', price_brackets: form.price_brackets };
  return { ...rest, unit_price: form.unit_price ?? '' };
}

// A new row's price: the same kind as the item's own (the schema needs that for a per-room item),
// every price blank so the owner types it; a bracketed item's row starts with the same band limits.
function blankForm(item: Item): PriceForm {
  if (item.unit === 'room') return { tier_prices: { ...BLANK_TIERS } };
  if (item.price_brackets) return { price_brackets: item.price_brackets.map((band) => ({ ...band, unit_price: '' })) };
  return { unit_price: '' };
}

export function rowForm(row: PriceRow): PriceForm {
  if (row.tier_prices) return { tier_prices: row.tier_prices };
  if (row.price_brackets) return { price_brackets: row.price_brackets };
  return { unit_price: row.unit_price ?? '' };
}

export function rowId(row: Pick<PriceRow, 'category' | 'room_type'>): string {
  return `${row.room_type ?? ''}|${row.category ?? ''}`;
}

function withRows(item: Item, rows: PriceRow[]): Item {
  const { rows: _old, ...rest } = item;
  void _old;
  const sorted = [...rows].sort((left, right) => {
    const type = (left.room_type ?? '').localeCompare(right.room_type ?? '');
    if (type) return type;
    const rank = (row: PriceRow) => (row.category === undefined ? -1 : CATEGORIES.indexOf(row.category));
    return rank(left) - rank(right);
  });
  return sorted.length ? { ...rest, rows: sorted } : rest;
}

export function setRowForm(item: Item, id: string, form: PriceForm): Item {
  return withRows(
    item,
    (item.rows ?? []).map((row) => {
      if (rowId(row) !== id) return row;
      const kept: PriceRow = {};
      if (row.room_type !== undefined) kept.room_type = row.room_type;
      if (row.category !== undefined) kept.category = row.category;
      return { ...kept, ...form };
    }),
  );
}

export function removeRow(item: Item, id: string): Item {
  return withRows(item, (item.rows ?? []).filter((row) => rowId(row) !== id));
}

// "Price varies by water category" on an item: it has a row for a category and no room type.
export function categoryPricingOn(item: Item): boolean {
  return (item.rows ?? []).some((row) => row.room_type === undefined && row.category !== undefined);
}

// Turning it on adds a blank row for each category the item is used in; turning it off removes
// those rows, so the item shows one price again (room-type rows stay).
export function setCategoryPricing(item: Item, on: boolean): Item {
  const rows = (item.rows ?? []).filter((row) => row.room_type !== undefined || row.category === undefined);
  if (!on) return withRows(item, rows);
  const kept = new Map((item.rows ?? []).map((row) => [rowId(row), row]));
  const added = itemCategories(item).map((category) => kept.get(rowId({ category })) ?? { category, ...blankForm(item) });
  return withRows(item, [...rows, ...added]);
}

// A row for a room type, or for a room type and one category, when "Price varies by room type" is on.
export function addRoomTypeRow(item: Item, roomType: string, category?: Category): Item {
  const row: PriceRow = category === undefined ? { room_type: roomType } : { room_type: roomType, category };
  if ((item.rows ?? []).some((existing) => rowId(existing) === rowId(row))) return item;
  return withRows(item, [...(item.rows ?? []), { ...row, ...blankForm(item) }]);
}

// The categories an item is used in (none ticked means all four). Rows for a category it no longer
// uses are removed, as the schema refuses them; with "Price varies by water category" on, a category
// newly used gets a blank price of its own.
export function setItemCategories(item: Item, categories: Category[]): Item {
  const chosen = [...new Set(categories)].sort(categoryOrder);
  const all = chosen.length === 0 || chosen.length === CATEGORIES.length;
  const next = withRows(
    { ...item, categories: all ? [] : chosen },
    (item.rows ?? []).filter((row) => row.category === undefined || all || chosen.includes(row.category)),
  );
  return categoryPricingOn(next) ? setCategoryPricing(next, true) : next;
}

// Brackets: the bands' limits rise and the last is open-ended (null).
export function withBrackets(form: PriceForm, on: boolean): PriceForm {
  if (!on) return { unit_price: form.price_brackets?.[0]?.unit_price ?? form.unit_price ?? '' };
  return { price_brackets: [{ up_to_sf: null, unit_price: form.unit_price ?? '' }] };
}

export function addBand(bands: PriceBand[]): PriceBand[] {
  const limits = bands.map((band) => band.up_to_sf).filter((limit): limit is number => limit !== null);
  const next = (limits.at(-1) ?? 0) + 100;
  return [...bands.slice(0, -1), { up_to_sf: next, unit_price: '' }, bands.at(-1) ?? { up_to_sf: null, unit_price: '' }];
}

export function removeBand(bands: PriceBand[], index: number): PriceBand[] {
  const left = bands.filter((_, at) => at !== index);
  if (left.length === 0) return [{ up_to_sf: null, unit_price: '' }];
  return left.map((band, at) => (at === left.length - 1 ? { ...band, up_to_sf: null } : band));
}

// An id the schema accepts, made from a name: lowercase letters, digits and _, starting with a
// letter, not one already taken.
export function idFromName(name: string, taken: ReadonlySet<string>, max: number): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/_+$/, '') || 'new';
  const start = base.length < 2 ? `${base}_x` : base;
  const fit = (suffix: string) => `${start.slice(0, max - suffix.length)}${suffix}`;
  if (!taken.has(fit(''))) return fit('');
  for (let n = 2; ; n += 1) {
    const candidate = fit(`_${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

export function addTrade(table: Table, name: string): Table {
  const trades = table.trades ?? [];
  const trade: Trade = { trade_id: idFromName(name, new Set(trades.map((t) => t.trade_id)), 40), name, minimum_charge: '0' };
  return { ...table, trades: [...trades, trade] };
}

export function tradeInUse(table: Table, tradeId: string): boolean {
  return table.items.some((item) => item.trade === tradeId);
}

export function removeTrade(table: Table, tradeId: string): Table {
  if (tradeInUse(table, tradeId)) return table;
  const trades = (table.trades ?? []).filter((trade) => trade.trade_id !== tradeId);
  const { trades: _old, ...rest } = table;
  void _old;
  return trades.length ? { ...rest, trades } : (rest as Table);
}

export function setTrade(table: Table, tradeId: string, change: Partial<Pick<Trade, 'name' | 'minimum_charge'>>): Table {
  return { ...table, trades: (table.trades ?? []).map((trade) => (trade.trade_id === tradeId ? { ...trade, ...change } : trade)) };
}

export function addRoomType(table: Table, name: string): Table {
  const types = table.policy.room_types;
  const id = idFromName(name, new Set([...types.map((type) => type.id), OTHER_TYPE]), 30);
  return { ...table, policy: { ...table.policy, room_types: [...types, { id, name, suggested_items: [] }] } };
}

// Removing a room type removes its price rows too: a row may only name a type the table lists.
export function removeRoomType(table: Table, typeId: string): Table {
  return {
    ...table,
    items: table.items.map((item) =>
      item.rows?.some((row) => row.room_type === typeId) ? withRows(item, item.rows.filter((row) => row.room_type !== typeId)) : item,
    ),
    policy: { ...table.policy, room_types: table.policy.room_types.filter((type) => type.id !== typeId) },
  };
}

export function renameRoomType(table: Table, typeId: string, name: string): Table {
  return {
    ...table,
    policy: { ...table.policy, room_types: table.policy.room_types.map((type) => (type.id === typeId ? { ...type, name } : type)) },
  };
}

export function toggleSuggested(table: Table, typeId: string, itemId: string, on: boolean): Table {
  return {
    ...table,
    policy: {
      ...table.policy,
      room_types: table.policy.room_types.map((type) => {
        if (type.id !== typeId) return type;
        const rest = type.suggested_items.filter((id) => id !== itemId);
        return { ...type, suggested_items: on ? [...rest, itemId] : rest };
      }),
    },
  };
}

export function setPolicy(table: Table, change: Partial<Table['policy']>): Table {
  return { ...table, policy: { ...table.policy, ...change } };
}

// The table's text with every object's keys in order, so two tables that differ only in key order
// (an edit puts a key back in another place) count as the same.
function sortedText(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

// Whether the editor holds changes the server does not have yet.
export function changed(saved: Table, draft: Table): boolean {
  return sortedText(saved) !== sortedText(draft);
}

// Whether an adjustment name is within the most it holds, counted in characters the way the schema counts them.
export function adjustmentNameFits(value: string): boolean {
  return chars(value) <= 60;
}

// Named adjustments (S5b-7): the company's own discounts and charges. None are seeded; a new one is a
// percent discount with no value yet, which blocks saving until the owner enters one.
export function addAdjustment(table: Table, name: string): Table {
  const adjustments = table.adjustments ?? [];
  const adjustment: NamedAdjustment = {
    adjustment_id: idFromName(name, new Set(adjustments.map((row) => row.adjustment_id)), 40),
    name,
    kind: 'percent',
    direction: 'discount',
    value: '',
  };
  return { ...table, adjustments: [...adjustments, adjustment] };
}

export function setAdjustment(
  table: Table,
  adjustmentId: string,
  change: Partial<Pick<NamedAdjustment, 'name' | 'kind' | 'direction' | 'value'>>,
): Table {
  const { name, ...rest } = change;
  const accepted = name === undefined || name.trim() === '' || !adjustmentNameFits(name) ? rest : change;
  return {
    ...table,
    adjustments: (table.adjustments ?? []).map((row) => (row.adjustment_id === adjustmentId ? { ...row, ...accepted } : row)),
  };
}

export function removeAdjustment(table: Table, adjustmentId: string): Table {
  const adjustments = (table.adjustments ?? []).filter((row) => row.adjustment_id !== adjustmentId);
  const { adjustments: _old, ...rest } = table;
  void _old;
  return adjustments.length ? { ...rest, adjustments } : (rest as Table);
}
