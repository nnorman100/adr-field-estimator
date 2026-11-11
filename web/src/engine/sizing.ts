// IICRC S500 air-mover placement and the LGR dehumidification chart. Counts are advice, not prices.

import { Dec, ZERO, sumDec } from './decimal';
import { numberText } from './values';
import type { Inspection, Room } from './inspection';

const MOVER_MIN = Dec.fromInt(70);
const MOVER_MAX = Dec.fromInt(50);
const SMALL_ROOM = Dec.fromInt(25);
const LGR: Record<number, number> = { 1: 100, 2: 50, 3: 40, 4: 40 };
const WALLS =
  'Wet walls above 2 feet, wet ceilings and wall offsets over 18 inches add air movers and are not part of this floor-based range.';

export type RoomCheck = {
  name: string;
  status: 'not_applicable' | 'not_available' | 'available';
  missing?: string[];
  problem?: string;
  floorSf?: Dec;
  wetFloorSf?: Dec;
  wetFloorStated?: boolean;
  ceiling?: Dec;
  waterClass?: number;
  cubicFeet?: Dec;
  airMin?: number | null;
  airMax?: number | null;
  factor?: number;
  ppd?: Dec;
};

export type Sizing = {
  status: 'not_applicable' | 'not_available' | 'available';
  rooms: RoomCheck[];
  basis: Record<string, string>;
  air?: { entered: number; min: number | null; max: number | null; flag: string | null; reason: string };
  dehu?: {
    entered: number;
    recommendedPpd: number;
    unitPpd: number | null;
    recommendedUnits: number | null;
    flag: string | null;
    reason: string;
  };
};

function up(value: Dec): number {
  return Number(value.toIntegral('CEILING').toString());
}

function tenths(value: Dec): Dec {
  return value.quantize(-1, 'HALF_UP');
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}

function loss(room: Room): string {
  return room.loss ?? (room.category === 3 ? 'mold' : 'water');
}

function roomCheck(room: Room): RoomCheck {
  if (loss(room) === 'mold') return { name: room.name, status: 'not_applicable' };
  const missing: string[] = [];
  if (room.floorSf === null) missing.push('floor area');
  if (room.ceilingHeightFt === null) missing.push('ceiling height');
  if (room.waterClass === null) missing.push('water class');
  if (missing.length || room.floorSf === null || room.ceilingHeightFt === null || room.waterClass === null) {
    return { name: room.name, status: 'not_available', missing };
  }
  const floor = room.floorSf;
  const wet = room.wetFloorSf === null ? floor : room.wetFloorSf;
  if (wet.cmp(floor) > 0) {
    return { name: room.name, status: 'not_available', missing: [], problem: 'the wet floor area is larger than the floor area' };
  }
  const height = room.ceilingHeightFt;
  const cubic = floor.mul(height);
  const factor = LGR[room.waterClass] ?? 40;
  let low: number | null = null;
  let high: number | null = null;
  if (!wet.isZero()) {
    low = floor.cmp(SMALL_ROOM) < 0 ? 1 : 1 + up(wet.div(MOVER_MIN));
    high = 1 + up(wet.div(MOVER_MAX));
  }
  return {
    name: room.name,
    status: 'available',
    floorSf: floor,
    wetFloorSf: wet,
    wetFloorStated: room.wetFloorSf !== null,
    ceiling: height,
    waterClass: room.waterClass,
    cubicFeet: cubic,
    airMin: low,
    airMax: high,
    factor,
    ppd: tenths(cubic.div(Dec.fromInt(factor))),
  };
}

function airCheck(entered: number, low: number, high: number): [string, string] {
  if (entered < low) return ['below', `Fewer than the IICRC minimum of ${low} for the wet floor areas.`];
  if (entered > high) {
    return [
      'above',
      `More than the IICRC floor-based maximum of ${high}. Note any wet walls above 2 feet, wet ceilings or wall offsets over 18 inches that need the extra air movers.`,
    ];
  }
  return ['within', `Within the IICRC range of ${low} to ${high}.`];
}

function dehuCheck(entered: number, demand: Dec, rating: number | null): [number | null, string | null, string] {
  const ppd = up(demand);
  if (rating === null) {
    if (!entered) return [null, 'below', `No dehumidifier entered; ${ppd} pints/day are recommended.`];
    return [null, null, "Enter the dehumidifier's AHAM pints/day rating to compare."];
  }
  const units = up(demand.div(Dec.fromInt(rating)));
  const capacity = entered * rating;
  if (entered < units) {
    return [units, 'below', `${entered} × ${rating} = ${capacity} pints/day is less than the ${ppd} pints/day recommended.`];
  }
  if (entered > units) {
    return [
      units,
      'above',
      `${units} at ${rating} pints/day each cover the ${ppd} pints/day recommended; ${entered} are entered.`,
    ];
  }
  return [units, 'within', `${entered} × ${rating} = ${capacity} pints/day covers the ${ppd} recommended.`];
}

export function roomPpd(check: RoomCheck): Dec {
  return (check.cubicFeet ?? ZERO).div(Dec.fromInt(check.factor ?? 1));
}

export function equipmentSizing(data: Inspection): Sizing {
  const rooms = data.rooms.map((room) => roomCheck(room));
  const water = rooms.filter((room) => room.status !== 'not_applicable');
  if (!water.length) return { status: 'not_applicable', rooms, basis: {} };
  if (water.some((room) => room.status === 'not_available')) return { status: 'not_available', rooms, basis: {} };
  const demand = sumDec(water.map((room) => roomPpd(room)), ZERO);
  const unsized = water.filter((room) => room.airMin == null).map((room) => room.name);
  let low: number | null = null;
  let high: number | null = null;
  let flag: string | null = null;
  let reason: string;
  if (unsized.length) {
    reason = `Cannot size air movers: no wet floor area in ${unsized.join(', ')}. The floor-based IICRC placement does not cover wet walls only.`;
  } else {
    low = water.reduce((sum, room) => sum + (room.airMin ?? 0), 0);
    high = water.reduce((sum, room) => sum + (room.airMax ?? 0), 0);
    [flag, reason] = airCheck(data.airMovers, low, high);
  }
  const [units, dehuFlag, dehuReason] = dehuCheck(data.dehumidifiers, demand, data.dehumidifierPpd);
  const basis: Record<string, string> = {};
  if (low !== null) {
    const wet = sumDec(water.map((room) => room.wetFloorSf ?? ZERO), ZERO);
    basis.air_movers = `IICRC S500 minimum for ${numberText(wet)} sq ft of wet floor across ${count(water.length, 'room')}; the maximum is ${high}.`;
  }
  if (units !== null) {
    basis.dehumidifiers = `${up(demand)} pints/day recommended for the stated room volumes and classes; ${count(units, 'unit')} at ${data.dehumidifierPpd} pints/day each.`;
  }
  return {
    status: 'available',
    rooms,
    basis,
    air: { entered: data.airMovers, min: low, max: high, flag, reason },
    dehu: {
      entered: data.dehumidifiers,
      recommendedPpd: up(demand),
      unitPpd: data.dehumidifierPpd,
      recommendedUnits: units,
      flag: dehuFlag,
      reason: dehuReason,
    },
  };
}

export function letterParagraph(sizing: Sizing): string | null {
  if (sizing.status !== 'available' || !sizing.air || !sizing.dehu) return null;
  const lines = [
    'Equipment sizing check (IICRC S500 initial air mover placement; IICRC LGR dehumidification factor chart), from technician-confirmed room inputs:',
  ];
  for (const room of sizing.rooms) {
    if (room.status === 'not_applicable') {
      lines.push(`${room.name}: mold only; not part of the drying check.`);
      continue;
    }
    const floor = numberText(room.floorSf ?? ZERO);
    const wet = numberText(room.wetFloorSf ?? ZERO);
    const low = (room.floorSf ?? ZERO).cmp(SMALL_ROOM) < 0 ? '1 (room under 25 SF)' : `1 + ${wet} ÷ 70`;
    const source = room.wetFloorStated ? '' : ' (the whole floor; no smaller wet area entered)';
    const placement =
      room.airMin == null
        ? ''
        : `Air movers for ${wet} SF of wet floor${source}: ${low} to 1 + ${wet} ÷ 50, rounded up = ${room.airMin} to ${room.airMax}. `;
    const exact = roomPpd(room);
    const equals = tenths(exact).cmp(exact) === 0 ? '=' : '≈';
    lines.push(
      `${room.name}: ${floor} SF floor × ${numberText(room.ceiling ?? ZERO)} ft ceiling = ${numberText(room.cubicFeet ?? ZERO)} cu ft, water class ${room.waterClass}. ${placement}LGR dehumidification: ${numberText(room.cubicFeet ?? ZERO)} ÷ ${room.factor} ${equals} ${numberText(room.ppd ?? ZERO)} pints/day (AHAM).`,
    );
  }
  const rating = sizing.dehu.unitPpd;
  const movers = sizing.air.min === null ? '' : `${sizing.air.min} to ${sizing.air.max} air movers and `;
  const units = rating !== null ? `; ${count(sizing.dehu.recommendedUnits ?? 0, 'unit')} at ${rating} pints/day each` : '';
  lines.push(`Recommended: ${movers}${sizing.dehu.recommendedPpd} pints/day of LGR dehumidification (the room total, rounded up${units}).`);
  const rated = rating !== null ? ` rated ${rating} pints/day each` : '';
  lines.push(
    `Entered for this proposal: ${count(sizing.air.entered, 'air mover')} and ${count(sizing.dehu.entered, 'LGR dehumidifier')}${rated}.`,
  );
  lines.push(WALLS);
  return lines.join('\n');
}
