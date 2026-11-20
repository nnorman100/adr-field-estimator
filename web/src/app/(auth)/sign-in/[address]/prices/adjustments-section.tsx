'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Table } from '@/engine/table';
import { addAdjustment, adjustmentNameInput, removeAdjustment, setAdjustment } from '@/lib/prices/edit';
import { DecimalField, Hint, RadioGroup, Section, TextField } from './ui';

// The company's own named adjustments (S5b-7): a discount or a charge, a percent of the price or a
// fixed amount. None are seeded. An adjustment applies to a job only when it is approved there; on the
// proposal it prints as arithmetic after any price-point rounding. The example is a fixed sentence.

type Edit = { table: Table; onChange: (table: Table) => void };

export function AdjustmentsSection({ table, onChange }: Edit) {
  const [name, setName] = useState('');
  const adjustments = table.adjustments ?? [];
  return (
    <Section id="adjustments" title="Named adjustments">
      <Hint>
        Your own discounts and charges, such as a returning-customer discount. One applies to a job only when it is approved
        there. Example: a 10% discount on a $2,499.00 price prints as &ldquo;$2,499.00 &minus; Senior discount $249.90 =
        $2,249.10&rdquo;. Adjustments are not taxed; confirm that treatment with your accountant.
      </Hint>
      {adjustments.length === 0 ? <Hint>No adjustments yet.</Hint> : null}
      {adjustments.map((adjustment) => (
        <fieldset key={adjustment.adjustment_id} className="flex flex-col gap-3 rounded-md border border-foreground/20 p-3">
          <legend className="px-1 text-sm font-medium break-words">{adjustment.name}</legend>
          <TextField
            label="Adjustment name"
            value={adjustment.name}
            onChange={(value) => onChange(setAdjustment(table, adjustment.adjustment_id, { name: adjustmentNameInput(value) }))}
          />
          <RadioGroup
            legend="This adjustment is a"
            name={`adjustment-direction-${adjustment.adjustment_id}`}
            value={adjustment.direction}
            options={[
              { value: 'discount', label: 'Discount (lowers the price)' },
              { value: 'charge', label: 'Charge (raises the price)' },
            ]}
            onChange={(direction) => onChange(setAdjustment(table, adjustment.adjustment_id, { direction }))}
          />
          <RadioGroup
            legend="Kind of amount"
            name={`adjustment-kind-${adjustment.adjustment_id}`}
            value={adjustment.kind}
            options={[
              { value: 'percent', label: 'A percent of the price' },
              { value: 'amount', label: 'A fixed dollar amount' },
            ]}
            onChange={(kind) => onChange(setAdjustment(table, adjustment.adjustment_id, { kind }))}
          />
          <DecimalField
            label={adjustment.kind === 'percent' ? 'Percent (%)' : 'Amount'}
            prefix={adjustment.kind === 'percent' ? undefined : '$'}
            value={adjustment.value}
            hint={adjustment.kind === 'percent' && adjustment.direction === 'discount' ? 'A discount is at most 100%.' : undefined}
            onChange={(value) => onChange(setAdjustment(table, adjustment.adjustment_id, { value }))}
          />
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-10 whitespace-normal break-all py-2"
            onClick={() => onChange(removeAdjustment(table, adjustment.adjustment_id))}
          >
            Remove the {adjustment.name} adjustment
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-col gap-2">
        <TextField label="New adjustment" value={name} onChange={(value) => setName(adjustmentNameInput(value))} />
        <Button
          type="button"
          variant="outline"
          disabled={name.trim() === ''}
          onClick={() => {
            onChange(addAdjustment(table, name));
            setName('');
          }}
        >
          Add the adjustment
        </Button>
      </div>
    </Section>
  );
}
