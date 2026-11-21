// Makes a job of a seeded company genuinely ready to review (S5b-11): the company publishes prices
// and the job's current draft gets everything the readiness checklist asks for, written to the
// field database and the evidence registry as the app stores them. The readiness handler then
// answers "ready" by itself; nothing it answers is rewritten.
import { randomUUID } from 'node:crypto';
import { contentHash, ENGINE_VERSION, parseTable } from '../../../src/engine/table';
import { adminDb } from '../offline/world';
import { adminSql, currentDraftOf, type Company } from './seed';

const SHOTS = ['overview', 'surface', 'meter'] as const;

export async function completeJob(company: Company, jobId: string): Promise<{ draftId: string }> {
  const db = adminSql();
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Water extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      room_types: [],
    },
  });
  const [actor] = await db<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id} AND display_name = 'owner'`;
  await db`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${company.id}, 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${actor!.id}, ${`key-${randomUUID()}`})
  `;

  const draftId = await currentDraftOf(company.id, jobId);
  const roomId = randomUUID();
  const draft = adminDb().doc(`companies/${company.id}/drafts/${draftId}`);
  await draft.set({ field: { yearBuilt: 1985, roomOrder: [roomId], summary: 'Mold-affected material in the kitchen.', scopeConfirmed: true } }, { merge: true });
  await draft.collection('rooms').doc(roomId).set({ field: { name: 'Kitchen', category: 'mold', affectedSf: 80, moldCondition: 2 } });
  for (const shotTag of SHOTS) {
    const objectId = randomUUID();
    await db`
      INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
      VALUES (${company.id}, ${jobId}, ${objectId}, 'photo', ${`companies/${company.id}/jobs/${jobId}/photos/${objectId}`},
              ${'1731400000000000'}, ${objectId.replaceAll('-', '').repeat(2)}, 2048, 'image/jpeg', ${actor!.id})
    `;
    await draft.collection('photos').doc(objectId).set({ field: { roomId, shotTag, capturedAt: new Date().toISOString() } });
  }
  return { draftId };
}
