// Which of an item's price rows prices a room: the precedence rule of plan section 3.4, in one
// place, so the engine (price-v2.ts) and the Prices screen's "what does this room pay?" preview can
// never disagree about it. Pure, with type-only imports, so the browser can load it without the
// rest of the engine. It picks a row; it never computes a price.

import type { Item, PriceRow } from './table';
import type { Category } from './values';

/**
 * The row that prices a room: the most specific one wins, room type plus category, then room type,
 * then category; null means the item's default row. `roomType` is the type the room is priced as
 * (null for a type the table does not know, which matches none of the room-type rows).
 */
export function pickPriceRow(item: Pick<Item, 'rows'>, category: Category, roomType: string | null): PriceRow | null {
  const find = (type: string | null, rowCategory: Category | null): PriceRow | null =>
    item.rows?.find((row) => (row.room_type ?? null) === type && (row.category ?? null) === rowCategory) ?? null;
  return (roomType !== null && (find(roomType, category) ?? find(roomType, null))) || find(null, category) || null;
}
