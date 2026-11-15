'use client';

import { suggestEquipment } from '@/engine/suggestions';
import { toInspection } from '@/lib/field/inspection';
import type { FieldDraft } from '@/lib/field/store';

// The equipment counts the rooms suggest (S5a-10): air movers by IICRC S500 floor-based placement and
// dehumidification in pints a day, from each water room's floor area, ceiling height and water class
// (src/engine/suggestions.ts, which never reads a price). A suggestion only: the technician confirms
// or changes the counts in the boxes below it, and only the counts entered are priced.
export function EquipmentSuggestion({ draft }: { draft: FieldDraft }) {
  let result: ReturnType<typeof suggestEquipment>;
  try {
    result = suggestEquipment(toInspection(draft.field, draft.rooms));
  } catch {
    return null;
  }
  if (!result.ok || result.rooms.every((room) => room.status === 'mold')) return null;
  const needs = result.rooms.filter((room) => room.status === 'needs');
  const parts = [
    result.air_movers ? `${result.air_movers.min} to ${result.air_movers.max} air movers` : null,
    result.pints_per_day !== null ? `dehumidification of ${result.pints_per_day} pints a day` : null,
  ].filter(Boolean);
  return (
    <div role="note" className="flex flex-col gap-1 rounded-md bg-foreground/5 p-3 text-sm" aria-label="Suggested equipment">
      <p className="font-medium">Suggested from the rooms</p>
      {parts.length > 0 ? <p>{parts.join('; ')}.</p> : null}
      {needs.length > 0 ? (
        <ul className="list-disc pl-5">
          {needs.map((room) => (
            <li key={room.room}>
              {room.room}: {room.needs.length > 0 ? `add the ${room.needs.join(', ')}` : 'check the areas'}.
            </li>
          ))}
        </ul>
      ) : null}
      <p>Confirm or change the counts below; only the counts you enter are priced.</p>
    </div>
  );
}
