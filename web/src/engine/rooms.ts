// Room inputs the table reads: size tier, room type and affected-area band. Pure functions of one
// room and the owner's settings; they never read a price.

import { Dec } from './decimal';
import type { Room } from './inspection';
import type { Policy } from './table';
import { OTHER_TYPE, type AffectedBand, type SizeTier } from './values';

/**
 * How big a room is, for its size tier: its floor area. A room has several areas (floor, wet floor,
 * unfinished and finished demolition) and only the floor measures the room itself: the others
 * measure the work in it, so a small room with a lot of demolition stays small. Null when no floor
 * area is stated; the technician can confirm a size instead.
 */
export function roomSizeSf(room: Room): Dec | null {
  return room.floorSf !== null && !room.floorSf.isZero() ? room.floorSf : null;
}

/**
 * A room's size tier: the one the technician confirmed, else the tier its size falls in. A limit
 * is the largest size in its tier (up to and including), and XL is everything above the L limit.
 * Null when the room has no stated size or the owner has not set the limits.
 */
export function sizeTierOf(room: Room, policy: Policy): SizeTier | null {
  if (room.sizeTier !== null) return room.sizeTier;
  const size = roomSizeSf(room);
  const limits = policy.size_tiers;
  if (size === null || limits.s_up_to_sf === null || limits.m_up_to_sf === null || limits.l_up_to_sf === null) {
    return null;
  }
  if (size.cmp(Dec.fromInt(limits.s_up_to_sf)) <= 0) return 's';
  if (size.cmp(Dec.fromInt(limits.m_up_to_sf)) <= 0) return 'm';
  return size.cmp(Dec.fromInt(limits.l_up_to_sf)) <= 0 ? 'l' : 'xl';
}

/** Containment by affected area: up to 10 sq ft, over 10 through 100, over 100. */
export function affectedBandOf(affected: Dec): AffectedBand {
  if (affected.cmp(Dec.fromInt(10)) <= 0) return 'up_to_10';
  return affected.cmp(Dec.fromInt(100)) <= 0 ? 'over_10_to_100' : 'over_100';
}

/**
 * The room type a room is priced as: its own when the table lists it, Other for a room with none.
 * Null for a type the table does not know, which then prices from the rows without a room type.
 */
export function roomTypeOf(room: Room, policy: Policy): string | null {
  const id = room.roomTypeId ?? OTHER_TYPE;
  return id === OTHER_TYPE || policy.room_types.some((type) => type.id === id) ? id : null;
}
