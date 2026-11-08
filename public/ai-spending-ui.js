'use strict';
// Shared dispatch and company/user AI cooldowns; app state stays in app.js.
const aiPauses = new Map();
const aiPauseKey = (kind) => [state.user?.uid, window.WorkspaceUI?.context(), kind].join('|');
function aiWait(pause) {
  return Math.max(0, (aiPauses.get(pause) || 0) - Date.now());
}
function aiRefused(pause, e) {
  aiPauses.set(
    pause,
    Math.max(aiPauses.get(pause) || 0, Date.now() + Math.max(1, e.retryAfter) * 1000),
  );
  const wait = aiWait(pause);
  setTimeout(renderPhotos, wait + 20);
  return wait;
}
function aiGate(pause) {
  const seconds = Math.ceil(aiWait(pause) / 1000);
  if (seconds)
    throw Object.assign(
      Error(
        'AI is paused after a refusal. This stays on the phone and retries in ' +
          seconds +
          ' seconds.',
      ),
      { status: 429, retryAfter: seconds },
    );
}

async function api(path, { pause, ...options } = {}) {
  if (!navigator.onLine)
    throw Error('You are offline. Your draft is saved locally; reconnect to continue.');
  if (!state.user || !state.session)
    throw Error('Sign in with an approved, verified account to continue.');
  const [token, appCheckHeader] = await Promise.all([state.user.getIdToken(), appCheckHeaders()]),
    controller = new AbortController();
  aiGate(pause);
  const timer = setTimeout(() => controller.abort(), 115000);
  try {
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...options.headers,
        ...appCheckHeader,
        Authorization: 'Bearer ' + token,
        ...(state.session.workspaces_enabled ? { 'X-ADR-Workspace-Protocol': '1' } : {}),
      },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})),
        invalid =
          Array.isArray(payload.detail) && typeof payload.detail[0]?.msg === 'string'
            ? payload.detail[0].msg.replace(/^Value error, /, '')
            : '';
      const e = Error(
        typeof payload.detail === 'string'
          ? payload.detail
          : invalid || 'The request could not be completed. Retry.',
      );
      e.status = response.status;
      e.retryAfter = Number(response.headers.get('Retry-After') || 0);
      if (
        (e.status === 403 || e.status === 404 || e.status === 410) &&
        window.WorkspaceUI?.enabled()
      )
        queueMicrotask(() => WorkspaceUI.refresh().catch(() => {}));
      throw e;
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
