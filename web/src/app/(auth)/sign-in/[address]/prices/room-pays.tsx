'use client';

import { useState } from 'react';
import type { Table } from '@/engine/table';
import type { Category, SizeTier } from '@/engine/values';
import { CATEGORIES, OTHER_TYPE, SIZE_TIERS, TIER_NAMES, categoryName, roomPrices } from '@/lib/prices/screen';
import { PriceText } from './price-form';
import { Hint, RadioGroup, Section, Select } from './ui';

// "What does this room pay?" (plan Q4): pick a category, a size and, when prices vary by room type,
// a room type, and see every item priced room by room with the price that room uses and where it
// comes from. It shows the prices as set and names a multiplier; it adds nothing up. Totals come
// from the server's preview on the sample jobs.

export function RoomPays({
  table,
  title = 'What does this room pay?',
  unfinished = false,
}: {
  table: Table;
  title?: string;
  unfinished?: boolean;
}) {
  const [category, setCategory] = useState<Category>(3);
  const [tier, setTier] = useState<SizeTier>('m');
  const [chosenType, setRoomType] = useState<string>(table.policy.room_types[0]?.id ?? OTHER_TYPE);
  const byType = table.policy.room_type_pricing;
  const types = table.policy.room_types.some((type) => type.id === OTHER_TYPE)
    ? table.policy.room_types
    : [...table.policy.room_types, { id: OTHER_TYPE, name: 'Other', suggested_items: [] }];
  // A room type removed since it was chosen gives way to the first one listed, on screen and here.
  const roomType = types.some((type) => type.id === chosenType) ? chosenType : (types[0]?.id ?? OTHER_TYPE);
  const rows = roomPrices(table, { category, roomType: byType ? roomType : OTHER_TYPE, tier });
  const cabinetry = category === 3 && table.policy.cabinetry.multiplier !== '1';

  return (
    <Section id="room-pays" title={title}>
      <Hint>The price each item charges in one room. Whole-job items (call-out, equipment days, hours) are not listed.</Hint>
      <RadioGroup
        legend="Category"
        name="room-category"
        value={String(category)}
        options={CATEGORIES.map((value) => ({ value: String(value), label: categoryName(value) }))}
        onChange={(value) => setCategory(value === 'mold' ? 'mold' : (Number(value) as 1 | 2 | 3))}
      />
      {byType ? (
        <Select label="Room type" value={roomType} options={types.map((type) => ({ value: type.id, label: type.name }))} onChange={setRoomType} />
      ) : null}
      <Select
        label="Room size"
        value={tier}
        options={SIZE_TIERS.map((value) => ({ value, label: TIER_NAMES[value] }))}
        onChange={setTier}
      />
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {unfinished ? (
          <p>Correct the field marked &quot;Use a whole number&quot; to see what this room pays.</p>
        ) : rows.length === 0 ? (
          <p>No item that is on is used in this kind of room.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {(unfinished ? [] : rows).map((row) => (
            <li key={row.itemId} className="rounded-md border border-foreground/20 p-3">
              <p className="font-medium">{row.name}</p>
              <PriceText
                unit={row.unit}
                form={
                  row.price.kind === 'tier'
                    ? { unit_price: row.price.price }
                    : row.price.kind === 'brackets'
                      ? { price_brackets: row.price.bands }
                      : { unit_price: row.price.price }
                }
              />
              <p className="text-sm text-foreground/75">
                {row.row ? `The ${row.row} price, used as set.` : 'The default price.'}
                {row.price.kind === 'tier' ? ` ${TIER_NAMES[row.price.tier]} room.` : ''}
                {row.multiplier ? ` Times the ${categoryName(category)} multiplier, ${row.multiplier}.` : ''}
                {!row.row && cabinetry ? ' With custom cabinetry, the cabinetry multiplier may apply too.' : ''}
                {row.conditions.length ? ` Used ${row.conditions.join(', ')}.` : ''}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
