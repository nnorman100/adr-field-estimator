// Suggested equipment counts from each room's water class and volume. A pure function that never
// reads a price: the technician confirms or changes the counts on Check Scope, and only the
// counts the technician enters are priced.

import { Dec, ZERO, sumDec } from './decimal';
import { validateInspection } from './inspection';
import type { Json } from './json';
import { roomCheck, roomPpd, up } from './sizing';

export type RoomSuggestion = {
  room: string;
  /** `ready` has every input; `mold` is not part of the drying check; `needs` lists what is missing. */
  status: 'ready' | 'mold' | 'needs';
  needs: string[];
  cubic_feet: string | null;
  pints_per_day: string | null;
  air_movers: { min: number; max: number } | null;
};

export type EquipmentSuggestion = {
  ok: true;
  rooms: RoomSuggestion[];
  /** Totals over the ready rooms only; `complete` says whether every water room was ready. */
  air_movers: { min: number; max: number } | null;
  pints_per_day: number | null;
  dehumidifiers: number | null;
  complete: boolean;
};

/**
 * Air movers (IICRC S500 floor-based placement) and LGR dehumidifier capacity (room cubic feet
 * divided by the factor for the water class) for each room, and in total. `inspection` is the saved
 * draft's JSON; `dehumidifier_ppd` in it, when set, turns pints per day into a unit count.
 */
export function suggestEquipment(inspection: Json): EquipmentSuggestion | { ok: false; error: string } {
  let data;
  try {
    data = validateInspection(inspection);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const checks = data.rooms.map((room) => roomCheck(room));
  const rooms = checks.map((check): RoomSuggestion => {
    if (check.status === 'not_applicable') {
      return { room: check.name, status: 'mold', needs: [], cubic_feet: null, pints_per_day: null, air_movers: null };
    }
    if (check.status === 'not_available') {
      const needs = check.missing?.length ? check.missing : check.problem ? [check.problem] : [];
      return { room: check.name, status: 'needs', needs, cubic_feet: null, pints_per_day: null, air_movers: null };
    }
    return {
      room: check.name,
      status: 'ready',
      needs: [],
      cubic_feet: (check.cubicFeet ?? ZERO).normalize().format('f'),
      pints_per_day: (check.ppd ?? ZERO).normalize().format('f'),
      air_movers: check.airMin != null && check.airMax != null ? { min: check.airMin, max: check.airMax } : null,
    };
  });
  const ready = checks.filter((check) => check.status === 'available');
  const sized = ready.filter((check) => check.airMin != null);
  const demand = sumDec(ready.map((check) => roomPpd(check)), ZERO);
  const rating = data.dehumidifierPpd;
  return {
    ok: true,
    rooms,
    air_movers: sized.length
      ? {
          min: sized.reduce((sum, check) => sum + (check.airMin ?? 0), 0),
          max: sized.reduce((sum, check) => sum + (check.airMax ?? 0), 0),
        }
      : null,
    pints_per_day: ready.length ? up(demand) : null,
    dehumidifiers: ready.length && rating !== null ? up(demand.div(Dec.fromInt(rating))) : null,
    complete: checks.every((check) => check.status !== 'not_available'),
  };
}
