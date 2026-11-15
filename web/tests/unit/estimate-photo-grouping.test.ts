import { describe, expect, it } from 'vitest';
import { priceEstimate, type Estimate, type Json } from '@/engine/estimate';
import { estimateInput, NO_ROOM } from '@/lib/estimates/inputs';
import { photoAlbums } from '@/lib/estimates/screen';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, storedManifest, type Snapshot } from '@/lib/submissions/snapshot';

// S5a-9c: the Photo audit log in the company's grouping (docs/plans/S5.md). `room` is today's
// order and today's bytes; `shot_tag` lists albums in the field map's shot-tag order, photos with no
// tag last, each album in the snapshot's order. Only the order and the album headings change: the
// photo ids, hashes, rooms and tags listed are the snapshot's in both groupings. Each snapshot here is
// stored as Submit stores it (`storedManifest`, photos sorted by id), so the snapshot's order is the
// photo ids' order, not the order the photos were given in: the snapshot holds no capture time.

const id = (digit: string) => digit.repeat(8) + '-' + digit.repeat(4) + '-4' + digit.repeat(3) + '-8' + digit.repeat(3) + '-' + digit.repeat(12);
const hash = (digit: string) => digit.repeat(64);
const [P1, P2, P3, P4, P5, P6, P7, PF] = ['1', '2', '3', '4', '5', '6', '7', 'f'].map(id) as [string, string, string, string, string, string, string, string];

// In the snapshot's order: kitchen source, hall overview, kitchen overview, hall untagged, hall
// source, no room equipment, kitchen surface. Room order is hall, then kitchen.
const PHOTOS: Array<[string, { roomId?: string; shotTag?: string }]> = [
  [P1, { roomId: 'kitchen', shotTag: 'source' }],
  [P2, { roomId: 'hall', shotTag: 'overview' }],
  [P3, { roomId: 'kitchen', shotTag: 'overview' }],
  [P4, { roomId: 'hall' }],
  [P5, { roomId: 'hall', shotTag: 'source' }],
  [P6, { shotTag: 'equipment' }],
  [P7, { roomId: 'kitchen', shotTag: 'surface' }],
];

function snapshot(photos = PHOTOS): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    draftId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fieldSha256: hash('d'),
    field: storedManifest({
      draft: { yearBuilt: 1972, roomOrder: ['hall', 'kitchen'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true },
      rooms: [
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      ],
      photos: photos.map(([photo, field]) => ({ id: photo, field })),
    }),
    photos: photos
      .map(([photo]) => ({ id: photo, sha256: hash(photo[0]!), sizeBytes: 100, contentType: 'image/jpeg' }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0100', email: 'casey@example.invalid' },
    claim: {},
  };
}

const company = (photoLogGrouping: 'room' | 'shot_tag'): CompanyDocuments => ({
  identity: { companyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Valley Water Pros', address: '1 Synthetic Way', phone: '555-0199', email: 'o@example.invalid', license: '000002', signoff: 'Robin Example' },
  letterhead: NEUTRAL_LETTERHEAD,
  settings: { ...NEUTRAL_SETTINGS, photoLogGrouping },
  signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
});

const TABLE: Json = {
  items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
  policy: {
    estimate_mode: 'single',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    sales_tax: { enabled: false, percent: '0' },
  },
};

const log = (grouping: 'room' | 'shot_tag', record = snapshot()) => estimateInput(record, company(grouping)).job.documents!.photos as Array<Record<string, string>>;
const ids = (rows: Array<Record<string, string>>) => rows.map((row) => row.id);
const priced = (grouping: 'room' | 'shot_tag'): Estimate => {
  const result = priceEstimate(TABLE, estimateInput(snapshot(), company(grouping)).job);
  if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
  return result;
};

describe('the photo log grouped by room', () => {
  it('is the order and the rows S5a-9 made: rooms in the record’s room order, no room last, no album key', () => {
    const rows = log('room');
    expect(ids(rows)).toEqual([P2, P4, P5, P1, P3, P7, P6]);
    expect(rows.every((row) => !('album' in row))).toBe(true);
    expect(rows[0]).toEqual({ id: P2, room: 'Hall', sha256: hash('2'), shot_tag: 'overview' });
  });

  it('keeps the snapshot’s order inside a room: photos given as f… then 1… come out 1…, f…', () => {
    const record = snapshot([[PF, { roomId: 'hall', shotTag: 'overview' }], [P1, { roomId: 'hall', shotTag: 'source' }]]);
    expect(record.field.photos.map((photo) => photo.id)).toEqual([P1, PF]);
    expect(ids(log('room', record))).toEqual([P1, PF]);
  });
});

describe('the photo log grouped by shot tag', () => {
  it('lists the albums in the field map’s order, untagged photos last, each album in the snapshot’s order', () => {
    expect(ids(log('shot_tag'))).toEqual([P2, P3, P1, P5, P7, P6, P4]);
  });

  it('names each album on its photos, and each photo still names its room', () => {
    const rows = log('shot_tag');
    expect(rows.map((row) => [row.album, row.room])).toEqual([
      ['Overview', 'Hall'],
      ['Overview', 'Kitchen'],
      ['Source of loss', 'Kitchen'],
      ['Source of loss', 'Hall'],
      ['Affected surface', 'Kitchen'],
      ['Equipment', NO_ROOM],
      ['Not tagged', 'Hall'],
    ]);
  });

  it('keeps the snapshot’s order inside an album whichever room the photos are in: given f…, 2…, 1…, it is 1…, 2…, f…', () => {
    const record = snapshot([[PF, { roomId: 'kitchen', shotTag: 'meter' }], [P2, { roomId: 'hall', shotTag: 'meter' }], [P1, { shotTag: 'meter' }]]);
    expect(record.field.photos.map((photo) => photo.id)).toEqual([P1, P2, PF]);
    expect(ids(log('shot_tag', record))).toEqual([P1, P2, PF]);
  });

  it('with no photo tagged, makes one album of untagged photos in the snapshot’s order', () => {
    const rows = log('shot_tag', snapshot([[PF, { roomId: 'hall' }], [P1, { roomId: 'kitchen' }]]));
    expect(rows.map((row) => [row.id, row.album])).toEqual([[P1, 'Not tagged'], [PF, 'Not tagged']]);
    expect(rows.every((row) => !('shot_tag' in row))).toBe(true);
  });
});

describe('both groupings of one job', () => {
  const key = (row: Record<string, string>) => JSON.stringify({ ...row, album: undefined });
  it('list the same photos with the same ids, hashes, rooms and tags; only the order and the albums differ', () => {
    const byRoom = log('room');
    const byTag = log('shot_tag');
    expect(byTag).toHaveLength(PHOTOS.length);
    expect(byTag.map(key).sort()).toEqual(byRoom.map(key).sort());
    for (const row of byTag) expect(row.sha256).toBe(hash(row.id?.[0] ?? ''));
  });

  it('give the documents the same photos and the same price; the room log is byte-identical to the default settings', () => {
    const room = priced('room');
    const tag = priced('shot_tag');
    expect(room.documents!.photo_log).toEqual(log('room'));
    expect(JSON.stringify(room.documents!.photo_log)).toBe(JSON.stringify(estimateInput(snapshot(), { ...company('room'), settings: NEUTRAL_SETTINGS }).job.documents!.photos));
    expect(tag.documents!.photo_log).toEqual(log('shot_tag'));
    expect(tag.totals).toEqual(room.totals);
    expect(tag.documents!.signable).toBe(room.documents!.signable);
  });
});

describe('the Review screen’s albums', () => {
  it('puts a heading above each album and numbers the photos straight through', () => {
    const albums = photoAlbums(log('shot_tag'));
    expect(albums.map((album) => album.heading)).toEqual(['Overview', 'Source of loss', 'Affected surface', 'Equipment', 'Not tagged']);
    expect(albums.map((album) => album.lines.length)).toEqual([2, 2, 1, 1, 1]);
    expect(albums[1]!.lines[0]).toBe('Photo 3 · Kitchen · shot: source · SHA-256 ' + hash('1').slice(0, 12) + '…');
    expect(albums[4]!.lines).toEqual(['Photo 7 · Hall · SHA-256 ' + hash('4').slice(0, 12) + '…']);
  });

  it('shows the room log as one list with no headings', () => {
    const albums = photoAlbums(log('room'));
    expect(albums).toHaveLength(1);
    expect(albums[0]!.heading).toBeNull();
    expect(albums[0]!.lines).toHaveLength(PHOTOS.length);
  });

  it('shows no albums for no photos', () => {
    expect(photoAlbums([])).toEqual([]);
  });
});
