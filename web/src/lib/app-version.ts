// Raise the minimum in a reviewed change when an older client can no longer write safely (O4).
export const CLIENT_EPOCH = 1;
export const MIN_CLIENT_EPOCH = 1;
export const CLIENT_EPOCH_HEADER = 'x-dryscope-client-epoch';
export const UPDATE_REQUIRED = 'update_required';

export function currentClientRefusal(request: Request): Response | null {
  const raw = request.headers.get(CLIENT_EPOCH_HEADER) ?? '';
  const epoch = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(epoch) && epoch >= MIN_CLIENT_EPOCH) return null;
  return Response.json({ error: UPDATE_REQUIRED }, { status: 426, headers: { 'Cache-Control': 'no-store' } });
}
