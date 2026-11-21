import { fieldId, SHOT_NAMES } from '@/lib/field/schema';
import { hrefOf, type JobView } from '@/lib/field/views';
import type { FieldManifest } from '@/lib/field/canonical';
import { BASELINE_SHOTS, CLAIM_KEYS, type ReadinessGap } from './check';

const general = {
  propertyAddress: ['Add the property address', 'customer', 'customer-propertyAddress'],
  yearBuilt: ['Add the year built', 'scope', 'fact-yearBuilt'],
  rooms: ['Add an affected room', 'scope', 'new-room-name'],
  equipment: ['Enter the drying equipment counts', 'scope', 'fact-airMovers'],
  summary: ['No summary of findings yet', 'scope', 'fact-summary'],
  scopeConfirmed: ['Confirm the scope', 'scope', 'fact-scopeConfirmed'],
} as const;

const roomGaps: Record<string, string> = {
  category: 'Choose water category or mold',
  demolitionArea: 'Enter the demolition area',
  wetFloorArea: 'Enter the wet floor or floor area',
  floorSf: 'Enter the floor area',
  ceilingHeightFt: 'Enter the ceiling height',
  waterClass: 'Choose the water class',
  wetFloorExceedsFloor: 'Check the wet floor and floor areas',
  affectedSf: 'Enter the mold-affected area',
  moldCondition: 'Choose the mold condition',
};

const claimLabels: Record<(typeof CLAIM_KEYS)[number], string> = {
  carrier: 'carrier',
  claimNumber: 'claim number',
  policyNumber: 'policy number',
  dateOfLoss: 'date of loss',
  lossCause: 'cause of loss',
  adjusterName: 'adjuster name',
  adjusterEmail: 'adjuster email',
  adjusterPhone: 'adjuster phone',
  deductible: 'deductible',
};

export function photoFix(target: string | null) {
  if (!target?.startsWith('photo:')) return null;
  const [, shotTag, roomId, extra] = target.split(':');
  const shot = BASELINE_SHOTS.find((tag) => tag === shotTag);
  const id = fieldId.safeParse(roomId);
  return shot && id.success && extra === undefined ? { shot, roomId: id.data } : null;
}

export function fixTarget(target: string | null, view: JobView): string | null {
  if (!target) return null;
  if (view === 'photos') return photoFix(target) ? 'photo-room' : null;
  if (Object.values(general).some(([, area, id]) => area === view && id === target)) return target;
  if (view === 'customer' && CLAIM_KEYS.some((key) => target === `claim-${key}`)) return target;
  const room = /^room-(.+)-heading$/.exec(target);
  if (view === 'scope' && room && fieldId.safeParse(room[1]).success) return target;
  return null;
}

function fieldFix(jobId: string, view: JobView, target: string) {
  const href = hrefOf({ jobId, view });
  return `${href}&fix=${encodeURIComponent(target)}`;
}

export type FixItem = { label: string; href?: string; action?: string };

export function fixFor(gap: ReadinessGap, jobId: string, manifest: FieldManifest, pricesHref: string | null, owner: boolean): FixItem | null {
  if (gap.code === 'prices') {
    if (pricesHref) return { label: 'Set up company prices', href: pricesHref, action: 'Open Prices' };
    return { label: owner ? 'Publish company prices before pricing this job.' : 'Ask your company owner to set up prices.' };
  }

  const claim = CLAIM_KEYS.find((key) => gap.code === `claim:${key}`);
  if (claim) return { label: `Add the claim’s ${claimLabels[claim]}`, href: fieldFix(jobId, 'customer', `claim-${claim}`) };

  const shot = BASELINE_SHOTS.find((tag) => gap.code === `shot:${tag}`);
  const room = manifest.rooms.find(({ id }) => id === gap.roomId);
  if (room) {
    const field = room.field as { name?: unknown } | null;
    const name = typeof field?.name === 'string' && field.name.trim() ? field.name : 'Unnamed room';
    if (shot) return { label: `${name}: Add ${shot === 'overview' || shot === 'surface' ? 'an' : 'a'} ${SHOT_NAMES[shot].toLowerCase()} photo`, href: fieldFix(jobId, 'photos', `photo:${shot}:${room.id}`) };
    if (roomGaps[gap.code]) return { label: `${name}: ${roomGaps[gap.code]}`, href: fieldFix(jobId, 'scope', `room-${room.id}-heading`) };
  }

  if (gap.code === 'scopeConfirmed' && (manifest.draft as { scopeConfirmed?: unknown } | null)?.scopeConfirmed === true) {
    return { label: 'The scope was confirmed before prices changed. Finish this draft, choose Back to editing, then confirm the scope again.' };
  }

  const fix = general[gap.code as keyof typeof general];
  return fix ? { label: fix[0], href: fieldFix(jobId, fix[1], fix[2]) } : null;
}
