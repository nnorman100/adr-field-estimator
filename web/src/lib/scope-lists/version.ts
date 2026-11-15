import { and, desc, eq } from 'drizzle-orm';
import { jobPricePins, priceTableVersions } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { contentHash, parseTable, type Table } from '@/engine/table';
import { OTHER_TYPE } from '@/engine/values';
import type { RoomField } from '@/lib/field/schema';

// The price version a job's room types and items come from (docs/plans/S5.md S5a-10): the job's
// pin when it has one, else the company's current version (the highest number), the one its first
// estimate will pin ("pin at first price", src/lib/estimates/service.ts). Check Scope offers this
// version's lists, and Submit checks a draft's ids against it; the estimate checks its items again
// against the version it prices from (`checkRoomItems` in src/engine/inspection.ts).

export class PricesUnreadable extends Error {
  constructor() {
    super('the price version does not parse or match its hash');
    this.name = 'PricesUnreadable';
  }
}

export type JobTable = { sequence: number; table: Table };

/** The job's price table, read through the one schema with its hash checked; null with no version. */
export async function jobPriceTable(tx: CompanyTransaction, companyId: string, jobId: string): Promise<JobTable | null> {
  const columns = { sequence: priceTableVersions.sequence, content: priceTableVersions.content, contentHash: priceTableVersions.contentHash };
  const [pinned] = await tx
    .select(columns)
    .from(jobPricePins)
    .innerJoin(priceTableVersions, and(eq(priceTableVersions.companyId, jobPricePins.companyId), eq(priceTableVersions.id, jobPricePins.versionId)))
    .where(and(eq(jobPricePins.companyId, companyId), eq(jobPricePins.jobId, jobId)))
    .orderBy(desc(jobPricePins.sequence))
    .limit(1);
  const [version] = pinned
    ? [pinned]
    : await tx.select(columns).from(priceTableVersions).where(eq(priceTableVersions.companyId, companyId)).orderBy(desc(priceTableVersions.sequence)).limit(1);
  if (!version) return null;
  let table: Table;
  try {
    table = parseTable(version.content);
  } catch {
    throw new PricesUnreadable();
  }
  if (contentHash(table) !== version.contentHash) throw new PricesUnreadable();
  return { sequence: version.sequence, table };
}

/** The items a room may list: those priced by a room's typed quantity (the engine's own rule). */
export function typedItemIds(table: Table): Set<string> {
  return new Set(table.items.filter((item) => item.quantity_source === 'room:typed').map((item) => item.item_id));
}

/** Whether any room names a room type (other than Other) or lists an item at all. */
export function namesPriceIds(rooms: RoomField[]): boolean {
  return rooms.some((room) => (room.roomTypeId !== undefined && room.roomTypeId !== OTHER_TYPE) || Object.keys(room.items ?? {}).length > 0);
}

/**
 * Whether every room's type and items are in `table` (null: no published version, so no id is).
 * Other, and a room with no type, is always known.
 */
export function priceIdsKnown(rooms: RoomField[], table: Table | null): boolean {
  if (!namesPriceIds(rooms)) return true;
  if (!table) return false;
  const types = new Set(table.policy.room_types.map((type) => type.id));
  const items = typedItemIds(table);
  return rooms.every(
    (room) =>
      (room.roomTypeId === undefined || room.roomTypeId === OTHER_TYPE || types.has(room.roomTypeId)) &&
      Object.keys(room.items ?? {}).every((id) => items.has(id)),
  );
}
