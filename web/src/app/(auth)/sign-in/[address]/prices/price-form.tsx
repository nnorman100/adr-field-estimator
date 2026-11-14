'use client';

import { Button } from '@/components/ui/button';
import type { PriceBand } from '@/engine/table';
import { addBand, removeBand, withBrackets, type PriceForm, type TierPrices } from '@/lib/prices/edit';
import { SIZE_TIERS, TIER_NAMES, moneyText, unitWords } from '@/lib/prices/screen';
import { CheckField, DecimalField, Hint, WholeField } from './ui';

// One price as the owner sets it: a single price, square-foot brackets (a sq ft item priced room by
// room), or four room-size prices (a per-room item). Used for an item's own price and for each of
// its rows. `label` names whose price it is ("Default price", "Category 3 price").

export function PriceFields({
  label,
  unit,
  form,
  bracketsAllowed,
  onChange,
}: {
  label: string;
  unit: string;
  form: PriceForm;
  bracketsAllowed: boolean;
  onChange: (form: PriceForm) => void;
}) {
  if (form.tier_prices) {
    const tiers = form.tier_prices;
    return (
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">{label}, by room size</legend>
        {SIZE_TIERS.map((tier) => (
          <DecimalField
            key={tier}
            label={`${TIER_NAMES[tier]} room`}
            prefix="$"
            value={tiers[tier]}
            onChange={(value) => onChange({ tier_prices: { ...tiers, [tier]: value } as TierPrices })}
          />
        ))}
        <Hint>A larger room never costs less than a smaller one.</Hint>
      </fieldset>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {bracketsAllowed ? (
        <CheckField
          label={`${label}: price by job size`}
          checked={Boolean(form.price_brackets)}
          hint="Different prices per sq ft as the square feet grow."
          onChange={(on) => onChange(withBrackets(form, on))}
        />
      ) : null}
      {form.price_brackets ? (
        <Bands label={label} bands={form.price_brackets} onChange={(bands) => onChange({ price_brackets: bands })} />
      ) : (
        <DecimalField
          label={`${label} (${unitWords(unit)})`}
          prefix="$"
          value={form.unit_price ?? ''}
          onChange={(value) => onChange({ unit_price: value })}
        />
      )}
    </div>
  );
}

function Bands({ label, bands, onChange }: { label: string; bands: PriceBand[]; onChange: (bands: PriceBand[]) => void }) {
  const set = (index: number, change: Partial<PriceBand>) =>
    onChange(bands.map((band, at) => (at === index ? { ...band, ...change } : band)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">{label}, per sq ft by size</legend>
      {bands.map((band, index) => {
        const last = index === bands.length - 1;
        const from = index === 0 ? 0 : bands[index - 1]?.up_to_sf;
        const name = last ? `Over ${from ?? 0} sq ft` : `Up to ${band.up_to_sf ?? '…'} sq ft`;
        return (
          <div key={index} className="flex flex-col gap-2 rounded-md border border-foreground/20 p-3">
            {last ? (
              <p className="text-sm font-medium">{name}</p>
            ) : (
              <WholeField label="Band ends at (sq ft)" value={band.up_to_sf} onChange={(value) => set(index, { up_to_sf: value })} />
            )}
            <DecimalField label={`Price ${name.toLowerCase()}`} prefix="$" value={band.unit_price} onChange={(value) => set(index, { unit_price: value })} />
            {bands.length > 1 ? (
              <Button type="button" variant="outline" onClick={() => onChange(removeBand(bands, index))}>
                Remove this band
              </Button>
            ) : null}
          </div>
        );
      })}
      {bands.length < 20 ? (
        <Button type="button" variant="outline" onClick={() => onChange(addBand(bands))}>
          Add a size band
        </Button>
      ) : null}
    </fieldset>
  );
}

// A price as text, for the read-only view: "$4.00 per sq ft", the bands, or the four room sizes.
export function PriceText({ unit, form }: { unit: string; form: PriceForm }) {
  if (form.tier_prices) {
    const tiers = form.tier_prices;
    return (
      <ul className="text-sm">
        {SIZE_TIERS.map((tier) => (
          <li key={tier}>
            {TIER_NAMES[tier]} room: {moneyText(tiers[tier])}
          </li>
        ))}
      </ul>
    );
  }
  if (form.price_brackets) {
    return (
      <ul className="text-sm">
        {form.price_brackets.map((band, index, all) => (
          <li key={index}>
            {band.up_to_sf === null ? `Over ${all[index - 1]?.up_to_sf ?? 0} sq ft` : `Up to ${band.up_to_sf} sq ft`}:{' '}
            {moneyText(band.unit_price)} per sq ft
          </li>
        ))}
      </ul>
    );
  }
  const price = form.unit_price ?? '';
  return <p className="text-sm">{price === '' ? 'Price not set' : `${moneyText(price)} ${unitWords(unit)}`}</p>;
}
