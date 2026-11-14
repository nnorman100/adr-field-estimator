'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Item, Table } from '@/engine/table';
import type { Category } from '@/engine/values';
import {
  addRoomTypeRow,
  categoryPricingOn,
  defaultForm,
  removeRow,
  rowForm,
  rowId,
  setCategoryPricing,
  setDefaultForm,
  setItemCategories,
  setRowForm,
} from '@/lib/prices/edit';
import { CATEGORIES, OTHER_TYPE, categoryName, isRoomItem, itemCategories, moneyText, rowName, unitWords } from '@/lib/prices/screen';
import { PriceFields } from './price-form';
import { CheckField, DecimalField, Hint, Select, TextField } from './ui';

// One item of the owner's price list, closed to a single line until opened. An item shows one price
// until the owner turns on "Price varies by water category" (plan section 3.4 and risk table): then
// it has a price for each category it is used in, used as set. With "Price varies by room type" on
// (a company setting), a room-type row can be added as well.

const LABOR_GROUPS = new Set(['demolition', 'treatment', 'labor']);

export function summaryPrice(item: Item): string {
  if (item.unit === 'room') {
    const tiers = item.tier_prices;
    return tiers && Object.values(tiers).every((price) => price !== '') ? `${moneyText(tiers.s)} and up per room` : 'Price not set';
  }
  if (item.price_brackets) return item.price_brackets.some((band) => band.unit_price === '') ? 'Price not set' : 'Priced by job size';
  return item.unit_price === '' ? 'Price not set' : `${moneyText(item.unit_price)} ${unitWords(item.unit)}`;
}

export function ItemCard({ table, item, onChange }: { table: Table; item: Item; onChange: (item: Item) => void }) {
  const roomItem = isRoomItem(item);
  const bracketsAllowed = item.unit === 'sf' && (roomItem || item.quantity_source === 'typed');
  const byCategory = categoryPricingOn(item);
  const typeRows = (item.rows ?? []).filter((row) => row.room_type !== undefined);
  const moldOnly = Boolean(item.mold_conditions?.length || item.affected_bands?.length);
  const set = (change: Partial<Item>) => onChange({ ...item, ...change });

  return (
    <details className="rounded-md border border-foreground/25 open:pb-4 [&_summary]:min-h-11">
      <summary className="flex cursor-pointer flex-col gap-0.5 px-3 py-2">
        <span className="font-medium">{item.name}</span>
        <span className="text-sm text-foreground/75">
          {item.enabled ? summaryPrice(item) : 'Off: not used on estimates'}
          {byCategory ? ' · varies by water category' : ''}
        </span>
      </summary>
      <div className="flex flex-col gap-4 px-3 pt-2">
        <CheckField
          label="Use this item on estimates"
          checked={item.enabled}
          hint="An item that is on needs a price before the prices can be published."
          onChange={(enabled) => set({ enabled })}
        />
        <TextField label="Name" value={item.name} maxLength={80} onChange={(name) => set({ name })} />
        <TextField
          label="What the customer reads"
          value={item.customer_description}
          maxLength={300}
          onChange={(customer_description) => set({ customer_description })}
        />
        {table.trades?.length ? (
          <Select
            label="Trade heading"
            value={item.trade ?? ''}
            options={[{ value: '', label: 'No heading' }, ...table.trades.map((trade) => ({ value: trade.trade_id, label: trade.name }))]}
            onChange={(trade) => onChange(trade ? { ...item, trade } : withoutTrade(item))}
          />
        ) : null}
        <PriceFields
          label={byCategory ? 'Default price' : 'Price'}
          unit={item.unit}
          form={defaultForm(item)}
          bracketsAllowed={bracketsAllowed}
          onChange={(form) => onChange(setDefaultForm(item, form))}
        />
        {roomItem ? (
          <CategoryPrices item={item} moldOnly={moldOnly} bracketsAllowed={bracketsAllowed} onChange={onChange} />
        ) : (
          <Hint>This item is priced for the whole job, not room by room, so its price does not vary by category or room type.</Hint>
        )}
        {roomItem && table.policy.room_type_pricing ? (
          <RoomTypePrices table={table} item={item} bracketsAllowed={bracketsAllowed} onChange={onChange} />
        ) : null}
        {roomItem && !table.policy.room_type_pricing && typeRows.length ? (
          <Hint>
            This item has {typeRows.length} room-type price{typeRows.length === 1 ? '' : 's'}, kept but not used while &quot;Price
            varies by room type&quot; is off.
          </Hint>
        ) : null}
        <ItemDetails item={item} set={set} />
      </div>
    </details>
  );
}

function withoutTrade(item: Item): Item {
  const { trade: _trade, ...rest } = item;
  void _trade;
  return rest;
}

function CategoryPrices({
  item,
  moldOnly,
  bracketsAllowed,
  onChange,
}: {
  item: Item;
  moldOnly: boolean;
  bracketsAllowed: boolean;
  onChange: (item: Item) => void;
}) {
  const used = itemCategories(item);
  const byCategory = categoryPricingOn(item);
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Used in rooms of</legend>
        {CATEGORIES.map((category) => (
          <CheckField
            key={String(category)}
            label={categoryName(category)}
            checked={used.includes(category)}
            disabled={moldOnly}
            onChange={(on) => onChange(setItemCategories(item, on ? [...used, category] : used.filter((c) => c !== category)))}
          />
        ))}
        {moldOnly ? <Hint>A mold condition or containment item is used in Mold rooms only.</Hint> : null}
      </fieldset>
      <CheckField
        label="Price varies by water category"
        checked={byCategory}
        hint="Off: one price, times the category multiplier in the estimate settings. On: a price for each category, used as set."
        onChange={(on) => onChange(setCategoryPricing(item, on))}
      />
      {byCategory
        ? (item.rows ?? [])
            .filter((row) => row.room_type === undefined && row.category !== undefined)
            .map((row) => (
              <div key={rowId(row)} className="flex flex-col gap-1">
                <PriceFields
                  label={`${categoryName(row.category as Category)} price`}
                  unit={item.unit}
                  form={rowForm(row)}
                  bracketsAllowed={bracketsAllowed}
                  onChange={(form) => onChange(setRowForm(item, rowId(row), form))}
                />
                {row.category === 'mold' ? null : <Hint>This category price replaces the multiplier.</Hint>}
              </div>
            ))
        : null}
    </div>
  );
}

function RoomTypePrices({
  table,
  item,
  bracketsAllowed,
  onChange,
}: {
  table: Table;
  item: Item;
  bracketsAllowed: boolean;
  onChange: (item: Item) => void;
}) {
  const types = table.policy.room_types.some((type) => type.id === OTHER_TYPE)
    ? table.policy.room_types
    : [...table.policy.room_types, { id: OTHER_TYPE, name: 'Other', suggested_items: [] }];
  const [type, setType] = useState(types[0]?.id ?? OTHER_TYPE);
  const [category, setCategory] = useState<string>('');
  const rows = (item.rows ?? []).filter((row) => row.room_type !== undefined);
  const categoryOptions = itemCategories(item).map((value) => ({ value: String(value), label: categoryName(value) }));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Room-type prices</legend>
      <Hint>The most specific price wins: room type and category, then room type, then category, then the default price.</Hint>
      {rows.map((row) => (
        <div key={rowId(row)} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
          <PriceFields
            label={`${rowName(table, row)} price`}
            unit={item.unit}
            form={rowForm(row)}
            bracketsAllowed={bracketsAllowed}
            onChange={(form) => onChange(setRowForm(item, rowId(row), form))}
          />
          <Button type="button" variant="outline" onClick={() => onChange(removeRow(item, rowId(row)))}>
            Remove the {rowName(table, row)} price
          </Button>
        </div>
      ))}
      <Select label="Room type" value={type} options={types.map((t) => ({ value: t.id, label: t.name }))} onChange={setType} />
      <Select
        label="Category"
        value={category}
        options={[{ value: '', label: 'Any category' }, ...categoryOptions]}
        onChange={setCategory}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => onChange(addRoomTypeRow(item, type, category === '' ? undefined : category === 'mold' ? 'mold' : (Number(category) as 1 | 2 | 3)))}
      >
        Add a room-type price
      </Button>
    </fieldset>
  );
}

function ItemDetails({ item, set }: { item: Item; set: (change: Partial<Item>) => void }) {
  return (
    <details className="rounded-md border border-foreground/15 px-3 py-2">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">More about this item</summary>
      <div className="flex flex-col gap-4 pt-2">
        <CheckField
          label="A price of $0.00 is meant"
          checked={item.allow_zero}
          hint="Publishing asks you to confirm a zero price again."
          onChange={(allow_zero) => set({ allow_zero })}
        />
        <DecimalField label="Waste (%)" value={item.waste_percent} onChange={(waste_percent) => set({ waste_percent })} />
        {isRoomItem(item) || item.unit === 'room' ? null : (
          <DecimalField
            label="Quantity when none is entered"
            value={item.default_quantity}
            onChange={(default_quantity) => set({ default_quantity })}
          />
        )}
        <CheckField
          label="Sales tax applies"
          checked={item.taxable}
          onChange={(taxable) => set(taxable ? { taxable } : { taxable, materials_share_percent: undefined })}
        />
        {item.taxable ? (
          <DecimalField
            label="Taxed share of the price (%)"
            value={item.materials_share_percent ?? '100'}
            hint="The materials part of the price that sales tax applies to. Confirm with your accountant."
            onChange={(materials_share_percent) => set({ materials_share_percent })}
          />
        ) : null}
        {LABOR_GROUPS.has(item.group) ? (
          <CheckField
            label="After-hours rate applies"
            checked={item.after_hours === true}
            hint="On an after-hours job, this item takes the after-hours multiplier."
            onChange={(on) => set({ after_hours: on ? true : undefined })}
          />
        ) : null}
        <CheckField
          label="No overhead and profit on this item"
          checked={item.no_overhead_profit === true}
          onChange={(on) => set({ no_overhead_profit: on ? true : undefined })}
        />
        <TextField
          label="Matches Xactimate line (office note)"
          value={item.xactimate_code}
          maxLength={80}
          hint="For your office only; it prints on the itemized claim, never on the proposal."
          onChange={(xactimate_code) => set({ xactimate_code })}
        />
      </div>
    </details>
  );
}
