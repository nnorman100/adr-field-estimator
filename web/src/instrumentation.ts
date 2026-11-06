import { parseConfig } from '@/lib/config';

// Runs once when the server starts: a missing or invalid setting stops the process before it
// serves any request. Next.js alone would keep listening and fail every request instead.
export function register() {
  try {
    parseConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
