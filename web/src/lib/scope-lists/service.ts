import { eq } from 'drizzle-orm';
import { companies } from '@/db/schema';
import { withCompany, type Database } from '@/db/tenant';
import { suggestedItems, type Table } from '@/engine/table';
import type { Category } from '@/engine/values';
import type { Capability } from '@/lib/access';
import { hasAny, jobAccess, JobError, type JobCaller } from '@/lib/jobs/access';
import { readDocumentSettings } from '@/lib/profile/settings';
import { jobPriceTable, typedItemIds } from './version';

// What Check Scope picks from for one job (docs/plans/S5.md S5a-10): the room types and the items a
// room may list from the job's price version (its pin, else the company's current version), and the
// company's prep-task templates (Company settings, S5a-4b). Names and units only: the phone never
// sees or works out a price. Everyone who can read the job reads these, so a read-only screen still
// shows a room type by its name.
const READ: readonly Capability[] = ['jobs_read'];

export type ScopeLists = {
  /** The price version the lists come from; null when the company has published none. */
  version: number | null;
  /**
   * The owner's room types, in the owner's order; each with the enabled items it suggests: whether a
   * room lists the item with a typed quantity, or the item is priced from the room's measurements or
   * the job's counts, and the categories it is priced for (none: every category).
   */
  roomTypes: { id: string; name: string; suggestedItems: SuggestedItem[] }[];
  /** The enabled items a room may list with a typed quantity, in the owner's order. */
  items: { itemId: string; name: string; unit: string }[];
  /** The company's prep-task templates, as the owner wrote them. */
  prepTasks: string[];
};

export type SuggestedItem = { itemId: string; name: string; unit: string; typed: boolean; categories: Category[] };

export type ScopeListsService = { read(caller: JobCaller, jobId: string): Promise<ScopeLists> };

function listsOf(table: Table | null): Pick<ScopeLists, 'roomTypes' | 'items'> {
  if (!table) return { roomTypes: [], items: [] };
  const typed = typedItemIds(table);
  const items = table.items
    .filter((item) => item.enabled && typed.has(item.item_id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item) => ({ itemId: item.item_id, name: item.name, unit: item.unit }));
  return {
    roomTypes: table.policy.room_types.map((type) => ({
      id: type.id,
      name: type.name,
      suggestedItems: suggestedItems(table, type.id).map((item) => ({
        itemId: item.item_id,
        name: item.name,
        unit: item.unit,
        typed: typed.has(item.item_id),
        categories: item.categories,
      })),
    })),
    items,
  };
}

export function scopeListsService(db: Database): ScopeListsService {
  return {
    async read(caller, jobId) {
      if (!hasAny(caller, READ)) throw new JobError('not_allowed');
      return withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, READ);
        const found = await jobPriceTable(tx, caller.companyId, jobId);
        const [company] = await tx.select({ documents: companies.profileDocuments }).from(companies).where(eq(companies.id, caller.companyId));
        if (!company) throw new JobError('not_found');
        return {
          version: found?.sequence ?? null,
          ...listsOf(found?.table ?? null),
          prepTasks: readDocumentSettings(company.documents).prep_tasks,
        };
      });
    },
  };
}
