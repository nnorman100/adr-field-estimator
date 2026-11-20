// The old app's drying watch status fixtures (tests/fixtures/drying-watch/states.json, the cases
// tests/test_drying_watch.py checks backend/drying_watch.py against), shaped as the rebuilt watch reads
// them: rooms by a stable id (here the old name, lower-cased) and the server's names for each reading's
// fields. A closed watch's earlier decision is its closing action.
import type { SignedRoom, WatchDecision, WatchFlag, WatchStatus } from '@/lib/drying/watch';

export type WatchFixture = {
  name: string;
  plannedDays: number;
  rooms: SignedRoom[];
  setupAt: string;
  at: string;
  readings: {
    id: string;
    kind: 'air' | 'material' | 'thermal';
    roomId: string | null;
    takenAt: string;
    zone?: string;
    gpp?: number;
    material?: string;
    unit?: string;
    moisture?: number;
    dryStandard?: number | null;
    affected?: boolean;
  }[];
  decisions: WatchDecision[];
  expected: { status: WatchStatus; flags: WatchFlag[]; nextDueAt: string | null };
};

export const WATCH_STATES: WatchFixture[] = [
  {
    name: 'clean dry-down',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-23T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-21T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 30,
        dryStandard: 12,
        affected: true,
      },
      {
        id: 'r2',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-22T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 20,
        dryStandard: 12,
        affected: true,
      },
      {
        id: 'r3',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-23T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 12,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'dry_standard_met',
      flags: [],
      nextDueAt: null,
    },
  },
  {
    name: 'stalled GPP',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-23T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'air',
        roomId: 'kitchen',
        takenAt: '2026-10-21T16:00:00Z',
        zone: 'affected',
        gpp: 70,
      },
      {
        id: 'r2',
        kind: 'air',
        roomId: 'kitchen',
        takenAt: '2026-10-22T16:00:00Z',
        zone: 'affected',
        gpp: 70,
      },
      {
        id: 'r3',
        kind: 'air',
        roomId: 'kitchen',
        takenAt: '2026-10-23T16:00:00Z',
        zone: 'affected',
        gpp: 70,
      },
      {
        id: 'r4',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-23T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: ['stalled'],
      nextDueAt: '2026-10-24T16:00:00Z',
    },
  },
  {
    name: 'overdue thirty hours',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-22T22:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-21T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: ['overdue'],
      nextDueAt: '2026-10-22T16:00:00Z',
    },
  },
  {
    name: 'no dry standard',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-23T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-23T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 10,
        dryStandard: null,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: ['missing_dry_standard'],
      nextDueAt: '2026-10-24T16:00:00Z',
    },
  },
  {
    name: 'two rooms one wet',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
      {
        id: 'bath',
        name: 'Bath',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-23T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-23T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 12,
        dryStandard: 12,
        affected: true,
      },
      {
        id: 'r2',
        kind: 'material',
        roomId: 'bath',
        takenAt: '2026-10-23T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: [],
      nextDueAt: '2026-10-24T16:00:00Z',
    },
  },
  {
    name: 'equipment pulled early',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-22T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-21T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [
      {
        action: 'close',
      },
    ],
    expected: {
      status: 'closed',
      flags: [],
      nextDueAt: null,
    },
  },
  {
    name: 'past signed plan',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-24T17:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-24T16:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: ['past_signed_plan'],
      nextDueAt: '2026-10-25T16:00:00Z',
    },
  },
  {
    name: 'California midnight',
    plannedDays: 3,
    rooms: [
      {
        id: 'kitchen',
        name: 'Kitchen',
      },
    ],
    setupAt: '2026-10-21T16:00:00Z',
    at: '2026-10-22T09:00:00Z',
    readings: [
      {
        id: 'r1',
        kind: 'air',
        roomId: 'kitchen',
        takenAt: '2026-10-22T06:00:00Z',
        zone: 'affected',
        gpp: 70,
      },
      {
        id: 'r2',
        kind: 'air',
        roomId: 'kitchen',
        takenAt: '2026-10-22T08:00:00Z',
        zone: 'affected',
        gpp: 70,
      },
      {
        id: 'r3',
        kind: 'material',
        roomId: 'kitchen',
        takenAt: '2026-10-22T08:00:00Z',
        material: 'Drywall',
        unit: '%WME',
        moisture: 22,
        dryStandard: 12,
        affected: true,
      },
    ],
    decisions: [],
    expected: {
      status: 'active',
      flags: [],
      nextDueAt: '2026-10-23T08:00:00Z',
    },
  },
];
