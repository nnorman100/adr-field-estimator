import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/engine/estimate';
import { estimateInput, readSnapshot } from '@/lib/estimates/inputs';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { photoFieldSchema } from '@/lib/field/schema';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, snapshotBytes, storedManifest, type Snapshot } from '@/lib/submissions/snapshot';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const P4 = '44444444-4444-4444-8444-444444444444';
const P5 = '55555555-5555-4555-8555-555555555555';
const P6 = '66666666-6666-4666-8666-666666666666';

const hash = (seed: string) => seed.repeat(64);

const COMPANY = (photoLogGrouping: 'room' | 'shot_tag'): CompanyDocuments => ({
  identity: {
    companyId: '00000000-0000-4000-8000-000000000001',
    name: 'Example Restoration',
    address: '100 Example Road',
    phone: '555-0100',
    email: 'office@example.invalid',
    license: '000001',
    signoff: 'Pat Example',
  },
  letterhead: NEUTRAL_LETTERHEAD,
  settings: { ...NEUTRAL_SETTINGS, photoLogGrouping },
  signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
});

const TABLE = {
  items: [{ item_id: 'demo', group: 'demolition', name: 'Demo', unit: 'sf', quantity_source: 'room:demolition:unfinished', unit_price: '2.00' }],
  policy: {
    estimate_mode: 'single',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    sales_tax: { enabled: false, percent: '0' },
  },
};

function makeSnapshot(
  photos: Array<[string, Record<string, unknown>]>,
  options: { receivedAt?: string } = {},
): Snapshot {
  const manifest: FieldManifest = {
    draft: { yearBuilt: 1995, roomOrder: ['kitchen', 'hall'], summary: 'Supply line failure.', scopeConfirmed: true },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 100, wetFloorSf: 80, unfinishedSf: 10 } },
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 20 } },
    ],
    photos: photos.map(([id, field]) => ({ id, field })),
  };
  return {
    format: SNAPSHOT_FORMAT,
    submissionId: '00000000-0000-4000-8000-000000000010',
    jobId: '00000000-0000-4000-8000-000000000011',
    draftId: '00000000-0000-4000-8000-000000000012',
    fieldSha256: hash('a'),
    field: storedManifest(manifest),
    photos: [...photos]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id], index) => ({
        id,
        sha256: hash(String((index % 9) + 1)),
        sizeBytes: 100 + index,
        contentType: 'image/jpeg',
        ...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
      })),
    job: { propertyAddress: '1 Example Street, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid' },
    claim: {},
  };
}

describe('photo capture time', () => {
  it('accepts valid client-clock ISO timestamps on photoFieldSchema and rejects invalid shapes', () => {
    for (const capturedAt of [
      new Date().toISOString(),
      '2026-11-15T04:00:00Z',
      '2026-11-15T04:00:00.123Z',
      '2026-11-15T04:00:00.123456-08:00',
    ]) {
      expect(photoFieldSchema.safeParse({ roomId: 'kitchen', shotTag: 'source', capturedAt }).success, capturedAt).toBe(true);
    }
    for (const bad of [
      '2026-11-15T04:00:00',
      '2026-11-15t04:00:00z',
      '2026-02-30T04:00:00Z',
      'not-a-timestamp',
      '',
      `2026-11-15T04:00:00.${'1'.repeat(25)}Z`,
      1731643200,
      new Date('2026-11-15T04:00:00Z'),
    ]) {
      expect(photoFieldSchema.safeParse({ roomId: 'kitchen', capturedAt: bad }).success, String(bad)).toBe(false);
    }
  });

  it('includes capturedAt in the manifest digest and preserves optional receivedAt in snapshot parsing', async () => {
    const base: FieldManifest = {
      draft: { roomOrder: ['kitchen'] },
      rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }],
      photos: [{ id: P1, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:00:00.000Z' } }],
    };
    const later: FieldManifest = {
      ...base,
      photos: [{ id: P1, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:00:01.000Z' } }],
    };
    expect(await manifestDigest(base)).not.toBe(await manifestDigest(later));

    const snap = makeSnapshot([[P1, { roomId: 'kitchen', capturedAt: '2026-11-15T10:00:00.000Z' }]], {
      receivedAt: '2026-11-15T10:05:00.000Z',
    });
    const parsed = readSnapshot(snapshotBytes(snap).bytes);
    expect(parsed.photos[0]!.receivedAt).toBe('2026-11-15T10:05:00.000Z');
  });

  it('orders each album in shot_tag grouping by capture time, breaks ties by id, and leaves untimed photos last in id order', () => {
    // IDs P1..P6 sit in reverse order of capture times inside Source of loss; P5/P2 tie on instant;
    // P3/P1 have no capture time and belong to the same album.
    const snap = makeSnapshot([
      [P4, { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:02:00.000Z' }],
      [P6, { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:00:00.000Z' }],
      [P5, { roomId: 'hall', shotTag: 'source', capturedAt: '2026-11-15T02:01:00-08:00' }],
      [P2, { roomId: 'hall', shotTag: 'source', capturedAt: '2026-11-15T10:01:00Z' }],
      [P3, { roomId: 'kitchen', shotTag: 'source' }],
      [P1, { roomId: 'kitchen', shotTag: 'source' }],
    ]);

    const input = estimateInput(snap, COMPANY('shot_tag'));
    const rows = input.job.documents!.photos as Array<{ id: string; sha256: string; album: string; captured_at?: string }>;
    // P6 (10:00), tie at 10:01 -> P2 before P5 by id, P4 (10:02), then untimed in snapshot id order (P1, P3).
    expect(rows.map((row) => row.id)).toEqual([P6, P2, P5, P4, P1, P3]);
    expect(rows.map((row) => row.captured_at)).toEqual([
      '2026-11-15T10:00:00.000Z',
      '2026-11-15T10:01:00Z',
      '2026-11-15T02:01:00-08:00',
      '2026-11-15T10:02:00.000Z',
      undefined,
      undefined,
    ]);
    // Photo ids and hashes match the snapshot one-for-one.
    expect(new Set(rows.map((row) => `${row.id}:${row.sha256}`))).toEqual(
      new Set(snap.photos.map((photo) => `${photo.id}:${photo.sha256}`)),
    );
  });

  it('orders each room group (and untagged-room photos) in room grouping by capture time, with untimed photos after timed ones', () => {
    const snap = makeSnapshot([
      [P1, { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:05:00Z' }],
      [P2, { roomId: 'kitchen', shotTag: 'overview' }],
      [P3, { roomId: 'kitchen', shotTag: 'surface', capturedAt: '2026-11-15T10:03:00Z' }],
      [P4, { roomId: 'hall', shotTag: 'overview', capturedAt: '2026-11-15T10:01:00Z' }],
      [P5, { shotTag: 'equipment', capturedAt: '2026-11-15T09:59:00Z' }],
      [P6, { shotTag: 'meter' }],
    ]);

    const input = estimateInput(snap, COMPANY('room'));
    const rows = input.job.documents!.photos as Array<{ id: string; room: string; captured_at?: string }>;
    // Kitchen first (P3 at 10:03, P1 at 10:05, untimed P2 last), then Hall (P4), then Not in a room (P5 timed, P6 untimed).
    expect(rows.map((row) => row.id)).toEqual([P3, P1, P2, P4, P5, P6]);
    expect(rows.map((row) => row.captured_at)).toEqual([
      '2026-11-15T10:03:00Z',
      '2026-11-15T10:05:00Z',
      undefined,
      '2026-11-15T10:01:00Z',
      '2026-11-15T09:59:00Z',
      undefined,
    ]);
  });

  it('produces byte-identical documents when no photo has a capture time, even if server receivedAt is present', () => {
    const untimedPhotos: Array<[string, Record<string, unknown>]> = [
      [P3, { roomId: 'hall', shotTag: 'overview' }],
      [P1, { roomId: 'kitchen', shotTag: 'source' }],
      [P2, { shotTag: 'meter' }],
    ];
    const withoutReceived = makeSnapshot(untimedPhotos);
    const withReceived = makeSnapshot(untimedPhotos, { receivedAt: '2026-11-15T10:05:00.000Z' });

    for (const grouping of ['room', 'shot_tag'] as const) {
      const a = priceEstimate(TABLE, estimateInput(withoutReceived, COMPANY(grouping)).job);
      const b = priceEstimate(TABLE, estimateInput(withReceived, COMPANY(grouping)).job);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error('expected priced');
      expect(JSON.stringify(b.documents)).toBe(JSON.stringify(a.documents));
      expect((b.documents!.photo_log as Array<Record<string, unknown>>).every((row) => !('captured_at' in row))).toBe(true);
    }
  });
});
