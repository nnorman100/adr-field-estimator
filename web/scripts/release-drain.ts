// How long the test release waits before it stages a new revision (docs/plans/S8/S8-2.md, the drain
// precondition). The database connection budget (web/src/db/client.ts) counts two revisions: the
// one serving traffic and the one being staged. A revision that lost its traffic can still hold
// connections: Cloud Run keeps an idle instance for up to 15 minutes, and "an idle instance might
// persist resources, such as open database connections"
// (https://docs.cloud.google.com/run/docs/about-instance-autoscaling, "Idle instances"). So the
// release stages only once 15 minutes have passed since the service last changed: Cloud Run's own
// record of the last traffic move, whether a release, a rollback or a move by hand made it.
//
// The time is the service's updateTime, "the last-modified time", from the Cloud Run Admin API v2
// (https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services). The deploy
// account reads it with run.services.get, which it already holds. Reading the revisions' actual
// instance counts instead needs a Cloud Monitoring read permission the deploy account does not
// have; that switch is a later owner choice.
//
//   curl .../v2/projects/<p>/locations/<r>/services/<s> | node web/scripts/release-drain.ts
//     (prints the seconds to wait, 0 to 900)
//
// Plain Node with type stripping; no installed packages.
import { pathToFileURL } from 'node:url';

/** Cloud Run keeps an idle instance for up to this long. */
export const DRAIN_SECONDS = 15 * 60;

/**
 * The whole seconds still to wait at `now` (milliseconds) before staging, for a Cloud Run v2
 * service resource. Never more than DRAIN_SECONDS, so a clock ahead of the runner's still waits the
 * full time and no longer.
 */
export function drainWaitSeconds(service: unknown, now: number): number {
  const updated = (service as { updateTime?: unknown } | null)?.updateTime;
  const at = typeof updated === 'string' ? Date.parse(updated) : NaN;
  if (!Number.isFinite(at)) throw new Error('the service has no updateTime');
  const left = Math.ceil((at + DRAIN_SECONDS * 1000 - now) / 1000);
  return Math.min(DRAIN_SECONDS, Math.max(0, left));
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  console.log(drainWaitSeconds(JSON.parse(input), Date.now()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'release drain failed');
    process.exit(1);
  });
}
