'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Policy, Table } from '@/engine/table';
import {
  addRoomType,
  addTrade,
  removeRoomType,
  removeTrade,
  renameRoomType,
  setPolicy,
  setTrade,
  toggleSuggested,
  tradeInUse,
} from '@/lib/prices/edit';
import { OTHER_TYPE } from '@/lib/prices/screen';
import { CheckField, DecimalField, Hint, RadioGroup, Section, Select, TextField, WholeField } from './ui';

// The parts of the owner's price table that are not one item: trade headings, room types with their
// suggested item lists, where each room size ends, and the estimate settings, each with a plain
// example. The examples are fixed sentences, not sums of this company's prices.

type Edit = { table: Table; onChange: (table: Table) => void };

export function HeadingsSection({ table, onChange }: Edit) {
  const [name, setName] = useState('');
  const trades = table.trades ?? [];
  return (
    <Section id="headings" title="Trade headings">
      <Hint>Headings group the items on this screen and on the itemized claim. A heading may have its own minimum charge.</Hint>
      {trades.map((trade) => (
        <fieldset key={trade.trade_id} className="flex flex-col gap-3 rounded-md border border-foreground/20 p-3">
          <legend className="px-1 text-sm font-medium">{trade.name}</legend>
          <TextField label="Heading name" value={trade.name} maxLength={60} onChange={(value) => onChange(setTrade(table, trade.trade_id, { name: value }))} />
          <DecimalField
            label="Minimum charge for this heading"
            prefix="$"
            value={trade.minimum_charge}
            hint="Example: with $250.00, a job whose items under this heading come to $180.00 is charged $250.00 for them. 0 means no minimum."
            onChange={(value) => onChange(setTrade(table, trade.trade_id, { minimum_charge: value }))}
          />
          {tradeInUse(table, trade.trade_id) ? (
            <Hint>Items use this heading, so it cannot be removed. Move them first.</Hint>
          ) : (
            <Button type="button" variant="outline" onClick={() => onChange(removeTrade(table, trade.trade_id))}>
              Remove the {trade.name} heading
            </Button>
          )}
        </fieldset>
      ))}
      {trades.length < 30 ? (
        <div className="flex flex-col gap-2">
          <TextField label="New heading" value={name} maxLength={60} onChange={setName} />
          <Button
            type="button"
            variant="outline"
            disabled={name.trim() === ''}
            onClick={() => {
              onChange(addTrade(table, name.trim()));
              setName('');
            }}
          >
            Add the heading
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

export function RoomTypesSection({ table, onChange }: Edit) {
  const [name, setName] = useState('');
  const types = table.policy.room_types;
  const items = table.items.filter((item) => item.enabled);
  return (
    <Section id="room-types" title="Room types">
      <Hint>
        A room type is a label with a suggested item list: choosing it on a room fills in those items for the technician to
        confirm. It changes no price unless &quot;Price varies by room type&quot; is on. Every room starts as Other.
      </Hint>
      {types.map((type) => (
        <details key={type.id} className="rounded-md border border-foreground/20 px-3 py-2">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            {type.name} · {type.suggested_items.length} suggested item{type.suggested_items.length === 1 ? '' : 's'}
          </summary>
          <div className="flex flex-col gap-3 pt-2">
            <TextField label="Room type name" value={type.name} maxLength={40} onChange={(value) => onChange(renameRoomType(table, type.id, value))} />
            <fieldset className="flex flex-col">
              <legend className="text-sm font-medium">Suggested items</legend>
              {items.map((item) => (
                <CheckField
                  key={item.item_id}
                  label={item.name}
                  checked={type.suggested_items.includes(item.item_id)}
                  onChange={(on) => onChange(toggleSuggested(table, type.id, item.item_id, on))}
                />
              ))}
            </fieldset>
            {type.id === OTHER_TYPE ? null : (
              <Button type="button" variant="outline" onClick={() => onChange(removeRoomType(table, type.id))}>
                Remove the {type.name} room type
              </Button>
            )}
          </div>
        </details>
      ))}
      {types.length < 30 ? (
        <div className="flex flex-col gap-2">
          <TextField label="New room type" value={name} maxLength={40} onChange={setName} />
          <Button
            type="button"
            variant="outline"
            disabled={name.trim() === ''}
            onClick={() => {
              onChange(addRoomType(table, name.trim()));
              setName('');
            }}
          >
            Add the room type
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

export function SizesSection({ table, onChange }: Edit) {
  const limits = table.policy.size_tiers;
  const set = (key: keyof Policy['size_tiers']) => (value: number | null) =>
    onChange(setPolicy(table, { size_tiers: { ...limits, [key]: value } }));
  return (
    <Section id="sizes" title="Room sizes">
      <Hint>
        A per-room item has four prices, one per room size. A room&apos;s size comes from its floor area. Example: with Small up to
        100 and Medium up to 250, a 180 sq ft room is Medium. Extra large is everything above Large.
      </Hint>
      <WholeField label="Small: up to (sq ft)" value={limits.s_up_to_sf} allowBlank onChange={set('s_up_to_sf')} />
      <WholeField label="Medium: up to (sq ft)" value={limits.m_up_to_sf} allowBlank onChange={set('m_up_to_sf')} />
      <WholeField label="Large: up to (sq ft)" value={limits.l_up_to_sf} allowBlank onChange={set('l_up_to_sf')} />
    </Section>
  );
}

export function SettingsSection({ table, onChange, published }: Edit & { published: boolean }) {
  const policy = table.policy;
  const set = (change: Partial<Policy>) => onChange(setPolicy(table, change));
  const assist = policy.assist;
  const setAssist = (change: Partial<Policy['assist']>) => set({ assist: { ...assist, ...change } });
  return (
    <Section id="settings" title="Estimate settings">
      <CheckField
        label="Price varies by room type"
        checked={policy.room_type_pricing}
        hint="A setting for the whole company. Off (the usual): room types are labels and change no price. On: an item may have its own price for a room type, and the most specific price wins."
        onChange={(room_type_pricing) => set({ room_type_pricing })}
      />
      {published ? (
        <RadioGroup
          legend="Estimates show"
          name="estimate-mode"
          value={policy.estimate_mode}
          options={[
            { value: 'range', label: 'A price range (low to high)' },
            { value: 'single', label: 'One price' },
          ]}
          onChange={(estimate_mode) => set({ estimate_mode })}
        />
      ) : (
        <Hint>You choose whether estimates show a range or one price when you first publish.</Hint>
      )}
      {policy.estimate_mode === 'range' && published ? <RangeFields table={table} onChange={onChange} /> : null}
      <WholeField
        label="Drying days the proposal assumes"
        value={assist.drying_days}
        hint="Example: 3 means the equipment is priced for 3 days unless the technician enters other days."
        onChange={(value) => value !== null && setAssist({ drying_days: value })}
      />
      <DecimalField
        label="Minimum job charge"
        prefix="$"
        value={policy.minimum_job_charge}
        hint="Example: with $500.00, a job that prices at $320.00 is charged $500.00. 0 means no minimum."
        onChange={(minimum_job_charge) => set({ minimum_job_charge })}
      />
      <DecimalField
        label="Overhead and profit (%)"
        value={policy.overhead_profit_percent}
        hint="Usually 0 for mitigation. Example: with 10, a $1,000.00 job adds a $100.00 overhead and profit line."
        onChange={(overhead_profit_percent) => set({ overhead_profit_percent })}
      />
      <CheckField
        label="Charge sales tax"
        checked={policy.sales_tax.enabled}
        hint="Tax applies to each taxable item's materials share. Confirm the rate and the treatment with your accountant."
        onChange={(enabled) => set({ sales_tax: { ...policy.sales_tax, enabled } })}
      />
      {policy.sales_tax.enabled ? (
        <DecimalField
          label="Sales tax rate (%)"
          value={policy.sales_tax.percent}
          onChange={(percent) => set({ sales_tax: { ...policy.sales_tax, percent } })}
        />
      ) : null}
      <DecimalField
        label="After-hours multiplier"
        value={policy.after_hours.multiplier}
        hint="1 to 2. Example: with 1.5, a $200.00 after-hours item on an after-hours job is charged $300.00."
        onChange={(multiplier) => set({ after_hours: { ...policy.after_hours, multiplier } })}
      />
      <TextField
        label="After-hours line name"
        value={policy.after_hours.label}
        maxLength={80}
        onChange={(label) => set({ after_hours: { ...policy.after_hours, label } })}
      />
      <CheckField
        label="Show each line's price on the customer proposal"
        checked={policy.show_line_breakdown}
        onChange={(show_line_breakdown) => set({ show_line_breakdown })}
      />
      <AdvancedSettings table={table} onChange={onChange} />
    </Section>
  );
}

function RangeFields({ table, onChange }: Edit) {
  const policy = table.policy;
  const set = (change: Partial<Policy>) => onChange(setPolicy(table, change));
  const assist = policy.assist;
  const setAssist = (change: Partial<Policy['assist']>) => set({ assist: { ...assist, ...change } });
  const range = policy.range;
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-foreground/20 p-3">
      <legend className="px-1 text-sm font-medium">The high end of the range</legend>
      <RadioGroup
        legend="The high end comes from"
        name="range-method"
        value={assist.range_method}
        options={[
          { value: 'cushion', label: 'A cushion on the labor and materials' },
          { value: 'uncertainty', label: 'Extra drying days and a hidden-damage allowance' },
        ]}
        onChange={(range_method) => setAssist({ range_method })}
      />
      {assist.range_method === 'cushion' ? (
        range.brackets ? (
          <Hint>These prices use cushion bands by job size, which this screen shows in the preview but does not change.</Hint>
        ) : (
          <>
            <WholeField label="Cushion: first (sq ft)" value={range.first_sf} onChange={(value) => value !== null && set({ range: { ...range, first_sf: value } })} />
            <DecimalField label="Cushion on the first sq ft (%)" value={range.first_percent} onChange={(first_percent) => set({ range: { ...range, first_percent } })} />
            <DecimalField
              label="Cushion beyond that (%)"
              value={range.beyond_percent}
              hint="Example: 50% on the first 1,000 sq ft and 20% beyond: a job's high end adds half its labor and materials up to that size."
              onChange={(beyond_percent) => set({ range: { ...range, beyond_percent } })}
            />
          </>
        )
      ) : (
        <>
          <WholeField
            label="Extra drying days at the high end"
            value={assist.extra_drying_days}
            onChange={(value) => value !== null && setAssist({ extra_drying_days: value })}
          />
          {(['1', '2', '3'] as const).map((key) => (
            <DecimalField
              key={key}
              label={`Hidden-damage allowance, Category ${key} (%)`}
              value={assist.hidden_damage_percent[key]}
              onChange={(value) => setAssist({ hidden_damage_percent: { ...assist.hidden_damage_percent, [key]: value } })}
            />
          ))}
        </>
      )}
    </fieldset>
  );
}

function AdvancedSettings({ table, onChange }: Edit) {
  const policy = table.policy;
  const set = (change: Partial<Policy>) => onChange(setPolicy(table, change));
  return (
    <details className="rounded-md border border-foreground/20 px-3 py-2">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">Advanced settings</summary>
      <div className="flex flex-col gap-4 pt-2">
        <Hint>
          Category multipliers apply only to an item&apos;s default price; a category price is used as set. They start at 1.
          Example: with 1.5 for Category 3 and a $4.00 default price, a Category 3 room pays $6.00 per sq ft.
        </Hint>
        {(['1', '2', '3'] as const).map((key) => (
          <DecimalField
            key={key}
            label={`Category ${key} multiplier`}
            value={policy.category_multipliers[key]}
            onChange={(value) => set({ category_multipliers: { ...policy.category_multipliers, [key]: value } })}
          />
        ))}
        <DecimalField
          label="Custom cabinetry multiplier (Category 3)"
          value={policy.cabinetry.multiplier}
          onChange={(multiplier) => set({ cabinetry: { ...policy.cabinetry, multiplier } })}
        />
        <Select
          label="Cabinetry multiplier applies to"
          value={policy.cabinetry.scope}
          options={[
            { value: 'finished_only', label: 'Finished-surface demolition only' },
            { value: 'all_cat3', label: 'Every item in the room' },
          ]}
          onChange={(scope) => set({ cabinetry: { ...policy.cabinetry, scope } })}
        />
        <RadioGroup
          legend="Size bands count"
          name="bracket-mode"
          value={policy.bracket_mode}
          options={[
            { value: 'tiered', label: 'Each sq ft at its own band (tiered)' },
            { value: 'whole-job', label: "The job's total sq ft picks one band (whole job)" },
          ]}
          onChange={(bracket_mode) => set({ bracket_mode })}
        />
        <Select
          label="Job size is measured by"
          value={policy.area_basis}
          options={[
            { value: 'demolition', label: 'Demolition area' },
            { value: 'demolition_with_waste', label: 'Demolition area with waste' },
            { value: 'wet_floor', label: 'Wet floor area' },
          ]}
          onChange={(area_basis) => set({ area_basis })}
        />
      </div>
    </details>
  );
}
