'use client';

import type { Item, Table } from '@/engine/table';
import { defaultForm, rowForm, rowId } from '@/lib/prices/edit';
import { rowName } from '@/lib/prices/screen';
import { PriceText } from './price-form';
import { Hint, Section } from './ui';

// The items of a table under their trade headings, in the owner's order: the editor's list (each
// item drawn by `render`) and the read-only list estimators and office staff see.

export function byHeading(table: Table, items: Item[]): Array<{ id: string; name: string; items: Item[] }> {
  const sorted = [...items].sort((left, right) => left.sort_order - right.sort_order);
  const groups = (table.trades ?? []).map((trade) => ({
    id: trade.trade_id,
    name: trade.name,
    items: sorted.filter((item) => item.trade === trade.trade_id),
  }));
  const known = new Set(groups.map((group) => group.id));
  const loose = sorted.filter((item) => item.trade === undefined || !known.has(item.trade));
  return [...groups, ...(loose.length ? [{ id: '', name: 'No heading', items: loose }] : [])].filter((group) => group.items.length);
}

export function ItemsByHeading({ table, items, render }: { table: Table; items: Item[]; render: (item: Item) => React.ReactNode }) {
  return (
    <>
      {byHeading(table, items).map((group) => (
        <div key={group.id || 'none'} className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">{group.name}</h3>
          <ul className="flex flex-col gap-2">
            {group.items.map((item) => (
              <li key={item.item_id}>{render(item)}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

// The read-only list: each item's price and, where it has them, the prices it charges by category
// or room type, as set. Room-type prices show only while "Price varies by room type" is on.
export function ReadOnlyItems({ table }: { table: Table }) {
  const items = table.items.filter((item) => item.enabled);
  return (
    <Section id="items" title="Price list">
      {items.length === 0 ? <p>No item is on in these prices.</p> : null}
      <ItemsByHeading
        table={table}
        items={items}
        render={(item) => {
          const rows = (item.rows ?? []).filter((row) => table.policy.room_type_pricing || row.room_type === undefined);
          return (
            <div className="flex flex-col gap-1 rounded-md border border-foreground/20 p-3">
              <p className="font-medium">{item.name}</p>
              <PriceText unit={item.unit} form={defaultForm(item)} />
              {rows.map((row) => (
                <div key={rowId(row)} className="flex flex-col">
                  <p className="text-sm font-medium">{rowName(table, row)}</p>
                  <PriceText unit={item.unit} form={rowForm(row)} />
                </div>
              ))}
              {rows.length ? <Hint>A category or room-type price is used as set, in place of the price above.</Hint> : null}
            </div>
          );
        }}
      />
    </Section>
  );
}
