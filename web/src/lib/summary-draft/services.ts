import { createTextArmor } from '@/lib/ai/armor';
import { postgresAiBudget } from '@/lib/ai/budget';
import { createAiBoundary } from '@/lib/ai/call';
import { parseAiClientConfig, vertexModel } from '@/lib/ai/client';
import { serverDatabase } from '@/lib/auth/services';
import { parseAiConfig, parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreSummaryDraftReader } from './draft-reader';
import { summaryDraftService, type SummaryDraftBoundary, type SummaryDraftService } from './service';

// Model Armor's answer is awaited this long before the call is refused (fails closed), as the
// evaluation runner waits (web/scripts/eval-ai.ts).
const ARMOR_TIMEOUT_MS = 10_000;

let service: SummaryDraftService | null = null;
let boundary: SummaryDraftBoundary | null = null;

// The real AI boundary: the Vertex text model, Model Armor on the environment's text template, and
// the Postgres ledger for the quota and the budget. Built on the first call whose company switch is
// on, so a missing AI setting fails that request closed and never a request with the switch off.
function aiBoundary(): SummaryDraftBoundary {
  if (!boundary) {
    const config = parseAiConfig(process.env);
    const ledger = postgresAiBudget(serverDatabase());
    boundary = createAiBoundary({
      model: vertexModel(parseAiClientConfig({ project: config.projectId })),
      armor: createTextArmor(config.armorTextTemplate, ARMOR_TIMEOUT_MS),
      quota: ledger,
      budget: ledger,
    });
  }
  return boundary;
}

// Built on the first request from the checked server configuration (the same field database the
// job drafts use), then reused. A missing setting throws and that request fails closed.
export function summaryDraftServices(): SummaryDraftService {
  if (!service) {
    const reader = firestoreSummaryDraftReader(firestoreFor(parseProjectionConfig(process.env)));
    service = summaryDraftService(serverDatabase(), reader, aiBoundary);
  }
  return service;
}
