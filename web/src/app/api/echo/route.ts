import { z } from 'zod';
import { publicRoute } from '@/lib/auth';

// Sample server route showing the boundary rule: parse every request body with Zod before use.
// It stores nothing and returns only the validated input.
export const echoSchema = z.object({ message: z.string().trim().min(1).max(200) });

export const POST = publicRoute(async (request: Request) => {
  const body: unknown = await request.json().catch(() => null);
  const parsed = echoSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  return Response.json({ message: parsed.data.message });
});
