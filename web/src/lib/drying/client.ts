import { z } from 'zod';

const roomId = z.string().nullable();
const date = z.string();
const base = {
  id: z.string(),
  roomId,
  roomLabel: z.string().nullable(),
  takenAt: date,
};
const note = { note: z.string() };
export const readingView = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('air'),
    reading: z.object({
      ...note,
      zone: z.string(),
      temperatureF: z.number(),
      relativeHumidity: z.number(),
    }),
    air: z.object({
      gpp: z.number(),
      dewPointF: z.number(),
      dewPointDepressionF: z.number(),
      vaporPressureInhg: z.number(),
      enthalpyBtuLb: z.number(),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal('material'),
    reading: z.object({
      ...note,
      material: z.string(),
      moisture: z.number(),
      unit: z.string(),
      dryStandard: z.number().nullable(),
      affected: z.boolean(),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal('thermal'),
    reading: z.object({ ...note, pattern: z.string(), deltaTF: z.number(), boundary: z.string() }),
  }),
]);
export type Reading = z.infer<typeof readingView>;
export const readingsPage = z.object({
  jobId: z.string(),
  readings: z.array(readingView),
  next: z.string().nullable(),
  canChange: z.boolean(),
});
export const dryingRooms = z.object({
  jobId: z.string(),
  rooms: z.array(z.object({ id: z.string(), label: z.string() })),
});
export const createReceipt = z.object({ reading: readingView });
export const voidReceipt = z.object({
  void: z.object({ id: z.string(), changeId: z.string(), voided: z.literal(true) }),
});

const watchAction = z.enum(['mark_dry', 'extend', 'close']);
export type WatchAction = z.infer<typeof watchAction>;
const decision = z.object({
  action: watchAction,
  reason: z.string(),
  at: date,
  by: z.object({ displayName: z.string().nullable() }),
});
const availableWatch = z.object({
  jobId: z.string(),
  agreementId: z.string(),
  factsHash: z.string(),
  status: z.enum(['active', 'dry_standard_met', 'marked_dry', 'closed']),
  nextDueAt: date.nullable(),
  lastReadingAt: date.nullable(),
  signedRooms: z.array(z.object({ id: z.string(), name: z.string() })),
  roomReadings: z.array(z.object({ roomId, lastReadingAt: date.nullable(), overdue: z.boolean() })),
  missingRooms: z.array(z.string()),
  flags: z.array(z.string()),
  airTrends: z.array(z.object({ roomId, trend: z.enum(['stalled', 'improving', 'recorded']) })),
  air: z.array(
    z.object({
      roomId,
      firstGpp: z.number(),
      latestGpp: z.number(),
      referenceGpp: z.number(),
      percent: z.number(),
      days: z.number(),
    }),
  ),
  summary: z.array(z.string()),
  decisions: z.array(decision),
  can: z.object({ markDry: z.boolean(), extend: z.boolean(), close: z.boolean() }),
});
export const watchView = z.union([
  availableWatch,
  z.object({ jobId: z.string(), status: z.literal('unavailable'), reason: z.literal('no_plan') }),
]);
export type AvailableWatch = z.infer<typeof availableWatch>;
export const watchReceipt = z.object({ receipt: decision.extend({ id: z.string() }) });

const watchFlag = z.object({ features: z.object({ drying_watch: z.literal(true) }) });
export const dryingWatchEnabled = (body: unknown): boolean => watchFlag.safeParse(body).success;

const errorBody = z.object({ error: z.string() });
export const dryingErrorCode = (body: unknown): string | undefined =>
  errorBody.safeParse(body).data?.error;
