/* ADR inspection lifecycle: safe DOM, private drafts and revision-bound signing. */
'use strict';
const $ = (id) => document.getElementById(id);
const {
  emptyData,
  stable,
  estimateLabel,
  pcmToFloat,
  aspect,
  scopeJobLabels,
  scopeRoomLabels,
  roomKey,
  applyScopeChanges,
  ingestTranscript,
  authStage,
  authMessage,
  authDomainFor,
  canonicalUrl,
  splitPhotos,
} = ADRCore;
const state = {
  user: null,
  session: null,
  draft: null,
  record: null,
  ack: null,
  documents: null,
  signed: null,
  signature: null,
  pendingAuthorization: null,
  localVersion: 0,
  conflict: false,
  syncing: false,
  ocr: new Map(),
  photoUrls: new Map(),
  media: null,
  socket: null,
  audio: null,
  node: null,
  frameTimer: null,
  playing: new Set(),
  audioTime: 0,
  liveReady: false,
  stopping: false,
  muted: false,
  retries: 0,
  lastSpeech: 0,
  firstAudio: true,
};
let syncChain = Promise.resolve(),
  saveTimer = null,
  persistTimer = null,
  dbPromise = null,
  auth = null,
  authSdk = null,
  waitingWorker = null;
let confirmedAuthorization = null,
  authEpoch = 0;
const newId = () => crypto.randomUUID().replaceAll('-', '');
const ui = {
  task: 'property',
  starting: false,
  auditing: false,
  fillingScope: false,
  documentSource: null,
  viewed: new Set(),
};
// The signing link minted for the open inspection; the server keeps only its digest.
const homeownerLink = { inspection: null, url: '', timer: null, checked: null };
let roomRemoval = null,
  validationControl = null;
function visibleBounds() {
  const viewport = window.visualViewport,
    top = viewport?.offsetTop || 0,
    bottom = top + (viewport?.height || innerHeight);
  const shell = document.querySelector('.inspection-shell'),
    header = shell.getBoundingClientRect(),
    footer = document.querySelector('.draft-actions').getBoundingClientRect();
  return {
    top:
      Math.max(
        top,
        getComputedStyle(shell).position === 'sticky' && header.height ? header.bottom : top,
      ) + 12,
    bottom: Math.min(bottom, footer.height ? footer.top : bottom) - 12,
  };
}
function revealControl(control, feedback) {
  if (!control?.isConnected || !control.getClientRects().length || control.closest('dialog[open]'))
    return;
  const bounds = visibleBounds(),
    rect = control.closest('label')?.getBoundingClientRect() || control.getBoundingClientRect();
  const error = feedback && !feedback.hidden ? feedback.getBoundingClientRect() : null,
    top = Math.min(rect.top, error?.top ?? rect.top),
    bottom = Math.max(rect.bottom, error?.bottom || rect.bottom),
    height = bottom - top;
  if (top >= bounds.top && bottom <= bounds.bottom) return;
  const target = bounds.top + Math.max(0, (bounds.bottom - bounds.top - height) / 2);
  window.scrollBy({ top: top - target, behavior: 'instant' });
}
function focusAndReveal(control, feedback) {
  control.focus({ preventScroll: true });
  revealControl(control, feedback);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (document.activeElement === control) revealControl(control, feedback);
    }),
  );
}
function initFocusVisibility() {
  const header = document.querySelector('.inspection-shell'),
    footer = document.querySelector('.draft-actions');
  const update = () => {
    const headerHeight = header.getBoundingClientRect().height,
      footerHeight = footer.getBoundingClientRect().height;
    const constrained =
      (window.visualViewport?.height || innerHeight) - headerHeight - footerHeight < 240;
    document.body.classList.toggle('constrained-viewport', constrained);
    document.documentElement.style.setProperty(
      '--overlay-top',
      (constrained ? 0 : headerHeight) + 'px',
    );
    document.documentElement.style.setProperty('--overlay-bottom', footerHeight + 'px');
    const active = document.activeElement;
    if (
      active?.matches(
        '#inspectionForm input,#inspectionForm select,#inspectionForm textarea,#signingArea button,#signingArea input',
      )
    ) {
      const feedback =
        validationControl === active
          ? $('validationFeedback')
          : active.id === 'documentsConfirmed'
            ? $('documentsConfirmedError')
            : active.id === 'clearSignature'
              ? $('signatureError')
              : active.id === 'authorizeJob'
                ? $('authorizationStatus')
                : null;
      requestAnimationFrame(() => revealControl(active, feedback));
    }
  };
  const observer = new ResizeObserver(update);
  observer.observe(header);
  observer.observe(footer);
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  update();
}
function clearValidationFeedback() {
  if (validationControl) {
    const ids = (validationControl.getAttribute('aria-describedby') || '')
      .split(' ')
      .filter((id) => id && id !== 'validationFeedback');
    if (ids.length) validationControl.setAttribute('aria-describedby', ids.join(' '));
    else validationControl.removeAttribute('aria-describedby');
    validationControl.removeAttribute('aria-invalid');
  }
  validationControl = null;
  $('validationFeedback').hidden = true;
  $('validationFeedback').textContent = '';
}
function showValidationFeedback(control, text = control.validationMessage) {
  clearValidationFeedback();
  validationControl = control;
  const section = control.closest('details');
  if (section) section.open = true;
  const feedback = $('validationFeedback');
  feedback.textContent = text;
  feedback.hidden = false;
  (control.closest('label') || control).after(feedback);
  control.setAttribute('aria-invalid', 'true');
  control.setAttribute(
    'aria-describedby',
    ((control.getAttribute('aria-describedby') || '') + ' validationFeedback').trim(),
  );
  focusAndReveal(control, feedback);
}
function closeMenus() {
  document.querySelectorAll('.menu[open]').forEach((menu) => (menu.open = false));
}
function showTask(task, focus = true) {
  ui.task = task;
  document
    .querySelectorAll('[data-panel]')
    .forEach((panel) => (panel.hidden = panel.dataset.panel !== task));
  document.querySelectorAll('.task-nav [data-task]').forEach((tab) => {
    if (tab.dataset.task === task) tab.setAttribute('aria-current', 'step');
    else tab.removeAttribute('aria-current');
  });
  closeMenus();
  if (focus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = $('panel-' + task).querySelector('h2');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  if (task === 'review') {
    requestAnimationFrame(resizeSignature);
    restoreHomeownerLink().catch(() => {});
  }
}
function renderControls() {
  const editable = !!state.session && !!state.draft && !state.signed && !confirmedAuthorization,
    active = !!state.media;
  $('panel-walkthrough').classList.toggle('capturing', active);
  $('startWalk').hidden = active;
  $('startWalk').disabled = !editable || !navigator.onLine || ui.starting || ui.fillingScope;
  $('startWalk').textContent = ui.starting
    ? 'Starting walkthrough…'
    : state.resumeAvailable
      ? 'Resume walkthrough'
      : 'Start walkthrough';
  $('stopWalk').hidden = !active;
  $('stopWalk').disabled = ui.starting;
  $('muteMic').hidden = !active;
  $('takePhoto').disabled = !editable || !active;
  $('uploadPhoto').disabled = !editable;
  $('thermalToggle').disabled = !active;
  $('photoRoom').disabled = !editable;
  $('saveDraft').disabled = !editable;
  $('finishAudit').disabled = !editable || !navigator.onLine || ui.auditing || ui.fillingScope;
  $('finishAudit').textContent = ui.auditing ? 'Generating…' : 'Finish & review';
  for (const id of ['fillScope', 'fillScopeProperty']) {
    $(id).disabled = !editable || !navigator.onLine || ui.fillingScope || ui.auditing;
    $(id).textContent = ui.fillingScope ? 'Reading walkthrough…' : 'Fill scope from walkthrough';
  }
  window.WorkspaceUI?.policy();
}
function selectDocument(name) {
  if (!state.documents) return;
  ADRDocuments.select(name, ui.viewed);
  if (name === 'proposal') requestAnimationFrame(resizeSignature);
}
function say(text, type = '') {
  const el = $('message');
  el.textContent = text;
  el.className = 'message ' + type;
  el.hidden = !text;
}
function authSay(text, type = '') {
  const el = $('authStatus');
  el.textContent = text;
  el.className = 'message ' + type;
  el.hidden = !text;
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
function button(text, fn) {
  const el = node('button', text);
  el.type = 'button';
  el.addEventListener('click', () => Promise.resolve(fn()).catch((e) => say(e.message, 'error')));
  return el;
}
function database() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('adr-private-drafts-v2', 2);
      request.onupgradeneeded = (event) => {
        const db = request.result,
          photos = db.createObjectStore('photos', { keyPath: ['draft_key', 'id'] });
        if (event.oldVersion < 1) {
          db.createObjectStore('drafts', { keyPath: 'key' });
          return;
        }
        // Moving version 1's embedded bytes inside the upgrade transaction means a failure leaves every version 1 row untouched.
        request.transaction.objectStore('drafts').openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const { draft, bytes } = splitPhotos(cursor.value.draft);
          for (const photo of bytes) photos.put({ draft_key: cursor.value.key, ...photo });
          cursor.update({ ...cursor.value, draft });
          cursor.continue();
        };
      };
      request.onblocked = () =>
        say(
          'Close other open copies of this app to finish updating private local storage.',
          'error',
        );
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(Error('This browser cannot store a recoverable local draft.'));
    });
  return dbPromise;
}
async function dbAction(mode, fn) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['drafts', 'photos'], mode);
    const request = fn(tx.objectStore('drafts'), tx.objectStore('photos'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () =>
      reject(Error('Local draft could not be saved. Keep this page open and retry.'));
  });
}
const photoRange = (key) => IDBKeyRange.bound([key], [key, []]);
async function photoBytes(key) {
  return new Map(
    (await dbAction('readonly', (drafts, photos) => photos.getAll(photoRange(key)))).map(
      (photo) => [photo.id, photo.data_url],
    ),
  );
}
function deleteDraft(key) {
  return dbAction('readwrite', (drafts, photos) => {
    photos.delete(photoRange(key));
    return drafts.delete(key);
  });
}
function draftKey(id) {
  return (
    state.user.uid +
    ':' +
    (state.session?.workspaces_enabled ? state.session.company_id + ':' : '') +
    id
  );
}
async function localDrafts() {
  const rows = await dbAction('readonly', (store) => store.getAll());
  return rows.filter(
    (r) =>
      r.uid === state.user?.uid &&
      (!state.session?.workspaces_enabled ||
        r.company_id === state.session.company_id ||
        (!r.company_id &&
          state.session.company_id === 'adr' &&
          !!state.session.role &&
          navigator.onLine)),
  );
}
async function persist() {
  clearTimeout(persistTimer);
  if (
    !state.user ||
    !state.draft ||
    state.signed ||
    (state.session?.workspaces_enabled && !state.session.role)
  )
    return;
  const key = draftKey(state.draft.inspection_id),
    { draft, bytes } = splitPhotos(state.draft);
  const row = {
    key,
    uid: state.user.uid,
    company_id: state.session?.company_id || null,
    draft: structuredClone(draft),
    record: structuredClone(state.record),
    ack: state.ack,
    session: state.session,
    updated_at: new Date().toISOString(),
  };
  await dbAction('readwrite', (drafts, photos) => {
    const stored = photos.getAllKeys(photoRange(key));
    stored.onsuccess = () => {
      const have = new Set(stored.result.map((k) => k[1])),
        keep = new Set(draft.photos.map((p) => p.id));
      for (const photo of bytes) if (!have.has(photo.id)) photos.put({ draft_key: key, ...photo });
      for (const k of stored.result) if (!keep.has(k[1])) photos.delete(k);
    };
    return drafts.put(row);
  });
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist().catch((e) => say(e.message, 'error')), 400);
}
async function clearLocal() {
  await dbAction('readwrite', (drafts, photos) => {
    photos.clear();
    return drafts.clear();
  });
}
// Unmodified Firebase JS SDK modular builds except for a same-origin import path (public/vendor/README.md).
// The SDK version is part of the path, so an upgrade cannot mix cached files from two releases.
const FIREBASE_SDK = '/vendor/firebase/13.0.0/';
// Public reCAPTCHA Enterprise site key registered for this web app in Firebase App Check (docs/app-check.md).
// Empty leaves App Check off and the app unchanged.
const APP_CHECK_SITE_KEY = '';
const APP_CHECK_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']),
  APP_CHECK_WAIT_MS = 3000;
let appCheck = null,
  appCheckStalled = false;
function loadAppCheck(siteKey = APP_CHECK_SITE_KEY) {
  if (!siteKey) return Promise.resolve(null);
  return import(FIREBASE_SDK + 'firebase-app-check.js').catch(() => null);
}
function activateAppCheck(app, sdk, siteKey = APP_CHECK_SITE_KEY) {
  if (!siteKey || !sdk) return;
  // The SDK reads this flag on activation; a debug token skips reCAPTCHA, so only local development and test origins keep it.
  if (!APP_CHECK_LOCAL_HOSTS.has(location.hostname))
    try {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = undefined;
    } catch {
      return;
    }
  const instance = sdk.initializeAppCheck(app, {
    provider: new sdk.ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  appCheck = { getToken: () => sdk.getToken(instance) };
}
async function appCheckToken() {
  // Monitor step: the backend only records a missing token, so a slow or failed attestation never holds a request.
  if (!appCheck) return '';
  // After one attestation outlasts the wait, later requests only take a token that is already available until it settles.
  let timer;
  const pending = appCheck.getToken().then((result) => {
    appCheckStalled = false;
    return result;
  });
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(
          () => {
            appCheckStalled = true;
            resolve();
          },
          appCheckStalled ? 0 : APP_CHECK_WAIT_MS,
        );
      }),
    ]);
    return typeof result?.token === 'string' ? result.token : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
async function appCheckHeaders() {
  const token = await appCheckToken();
  return token ? { 'X-Firebase-AppCheck': token } : {};
}
async function api(path, options = {}) {
  if (!navigator.onLine)
    throw Error('You are offline. Your draft is saved locally; reconnect to continue.');
  if (!state.user || !state.session)
    throw Error('Sign in with an approved, verified account to continue.');
  const [token, appCheckHeader] = await Promise.all([state.user.getIdToken(), appCheckHeaders()]),
    controller = new AbortController();
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
      if ((e.status === 403 || e.status === 404) && window.WorkspaceUI?.enabled())
        queueMicrotask(() => WorkspaceUI.refresh().catch(() => {}));
      throw e;
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
async function jsonApi(path, method = 'GET', body) {
  return (
    await api(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  ).json();
}
function absorb(record) {
  if (!state.draft || record.inspection_id !== state.draft.inspection_id) return;
  if (state.record && record.revision < state.record.revision) return;
  if (
    state.documents &&
    !state.signed &&
    (!record.audit || record.audit.revision !== record.revision)
  )
    invalidate();
  state.record = record;
  for (const remote of record.photos) {
    const photo = state.draft.photos.find((p) => p.id === remote.id);
    if (photo) Object.assign(photo, remote, { uploaded: true });
    else state.draft.photos.push({ ...remote, uploaded: true });
  }
  renderPhotos();
  renderSaveStatus();
}
function invalidate() {
  clearScopePreview();
  state.documents = null;
  state.signature = null;
  state.pendingAuthorization = null;
  ui.documentSource = null;
  ui.viewed.clear();
  stopHomeownerLink();
  document.body.classList.remove('has-documents');
  $('documentsConfirmed').checked = false;
  $('documents').hidden = true;
  $('reviewEmpty').hidden = false;
  clearSignature();
  clearSigningError('documentsConfirmedError');
}
function clearDisplayedInspection() {
  stopHomeownerLink();
  roomRemoval = null;
  $('removeRoomDialog').close();
  $('removeRoomDescription').textContent = '';
  clearValidationFeedback();
  clearSigningError('documentsConfirmedError');
  $('inspectionForm').before($('validationFeedback'));
  $('inspectionForm').reset();
  $('coordinationForm').reset();
  $('jobsDialog').close();
  for (const id of ['technicianTranscript', 'assistantTranscript']) $(id).value = '';
  for (const id of [
    'rooms',
    'photoRoom',
    'proposalBody',
    'claimCards',
    'claimItems',
    'claimParty',
    'defenseBody',
    'photoAuditLog',
    'scopeSuggestionList',
    'scopeQuestions',
    'jobsList',
  ])
    $(id).replaceChildren();
  for (const id of [
    'liveTranscriptPreview',
    'transcriptStatus',
    'authorizationStatus',
    'signedEvidenceStatus',
    'claimTotal',
    'estimateRange',
    'itemizedTotal',
    'auditWarnings',
    'scopeSuggestionStatus',
  ])
    $(id).textContent = '';
  if ($('savedSignature').src.startsWith('blob:')) URL.revokeObjectURL($('savedSignature').src);
  $('savedSignature').src = '';
  $('savedSignature').hidden = true;
  $('retrySavedEvidence').hidden = true;
  renderPhotos();
  renderSaveStatus();
  renderControls();
}
function changed(resetConfirmation = true) {
  if (!state.draft || state.signed || confirmedAuthorization) return;
  state.localVersion++;
  if (resetConfirmation) {
    state.draft.data.scope_confirmed = false;
    $('scopeConfirmed').checked = false;
  }
  invalidate();
  renderSaveStatus();
  schedulePersist();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => syncDraft().catch((e) => say(e.message, 'error')), 1500);
}
function renderSaveStatus() {
  $('jobTitle').textContent = state.draft?.data.address || 'New inspection';
  if (confirmedAuthorization) {
    $('saveStatus').textContent = 'Saved & signed · ' + confirmedAuthorization;
    return;
  }
  if (state.signed) {
    $('saveStatus').textContent = 'Saved & signed · ' + state.signed.auth_id;
    return;
  }
  if (!state.draft) {
    $('saveStatus').textContent = 'No customer information loaded.';
    return;
  }
  const synced =
    state.record &&
    stable(state.draft.data) === state.ack &&
    state.draft.photos.every((p) => p.uploaded);
  $('saveStatus').textContent = state.conflict
    ? 'Revision conflict · local draft preserved'
    : state.syncing
      ? 'Saving changes…'
      : synced
        ? 'Saved privately · revision ' + state.record.revision
        : navigator.onLine
          ? 'Changes saved on this device · cloud sync pending'
          : 'Saved on this device · offline';
}
async function reconcile() {
  const remote = await jsonApi('/api/inspections/' + state.draft.inspection_id);
  if (remote.status === 'signed' || (state.ack !== null && stable(remote.data) !== state.ack)) {
    state.conflict = true;
    $('conflictActions').hidden = false;
    throw Error(
      'The saved draft differs from your local work. Choose a recovery action; nothing was overwritten.',
    );
  }
  absorb(remote);
}
async function doSync() {
  if (!state.draft || state.signed || confirmedAuthorization || !state.session) return;
  await persist();
  if (window.WorkspaceUI?.enabled() && !WorkspaceUI.can('scope') && state.record) return;
  if (
    !navigator.onLine ||
    state.conflict ||
    (window.WorkspaceUI?.enabled() && !WorkspaceUI.can('jobs_create'))
  )
    return;
  const id = state.draft.inspection_id;
  state.syncing = true;
  renderSaveStatus();
  try {
    if (!state.record) {
      const data = structuredClone(state.draft.data);
      try {
        const record = await jsonApi('/api/inspections', 'POST', { inspection_id: id, data });
        state.ack = stable(data);
        absorb(record);
      } catch (e) {
        if (e.status !== 409) throw e;
        await reconcile();
      }
    }
    for (let attempt = 0; attempt < 3 && stable(state.draft.data) !== state.ack; attempt++) {
      const data = structuredClone(state.draft.data);
      try {
        const record = await jsonApi('/api/inspections/' + id, 'PUT', {
          expected_revision: state.record.revision,
          data,
        });
        state.ack = stable(data);
        absorb(record);
      } catch (e) {
        if (e.status !== 409) throw e;
        await reconcile();
      }
    }
    for (const photo of state.draft.photos.filter((p) => !p.uploaded)) {
      const payload = {
        photo_id: photo.id,
        expected_revision: state.record.revision,
        room: photo.room,
        captured_at: photo.captured_at,
        data_url: photo.data_url,
      };
      try {
        absorb(await jsonApi('/api/inspections/' + id + '/photos', 'POST', payload));
      } catch (e) {
        if (e.status !== 409) throw e;
        await reconcile();
        payload.expected_revision = state.record.revision;
        absorb(await jsonApi('/api/inspections/' + id + '/photos', 'POST', payload));
      }
    }
    for (const photo of state.draft.photos.filter((p) => p.uploaded && p.ocr_status === 'pending'))
      startOCR(photo);
    await loadPhotoUrls('/api/inspections/' + id + '/photos/');
  } finally {
    state.syncing = false;
    renderSaveStatus();
  }
}
function syncDraft() {
  clearTimeout(saveTimer);
  syncChain = syncChain.catch(() => {}).then(doSync);
  return syncChain;
}
let drainingQueue = false;
async function drainQueue() {
  if (
    drainingQueue ||
    state.queuePaused ||
    !navigator.onLine ||
    !state.session ||
    (window.WorkspaceUI?.enabled() && !WorkspaceUI.can('scope'))
  )
    return;
  drainingQueue = true;
  const uid = state.user.uid,
    queueContext = window.WorkspaceUI?.context();
  const guard = () => {
    if (
      state.user?.uid !== uid ||
      state.queuePaused ||
      !navigator.onLine ||
      queueContext !== window.WorkspaceUI?.context()
    )
      throw Error('Queue paused.');
  };
  const request = (...args) => {
    guard();
    return jsonApi(...args);
  };
  const saveRow = (row) => {
    guard();
    return dbAction('readwrite', (store) => {
      guard();
      return store.put(row);
    });
  };
  let conflicts = 0;
  try {
    await syncChain.catch(() => {});
    for (const row of await localDrafts()) {
      guard();
      if (row.draft.inspection_id === state.draft?.inspection_id) continue;
      const id = row.draft.inspection_id,
        path = '/api/inspections/' + id;
      let record;
      try {
        record = await request(path);
      } catch (e) {
        if (e.status !== 404) throw e;
        record = await request('/api/inspections', 'POST', {
          inspection_id: id,
          data: row.draft.data,
        });
        row.ack = stable(row.draft.data);
      }
      if (record.status === 'signed') {
        await deleteDraft(row.key);
        continue;
      }
      if (stable(row.draft.data) !== row.ack) {
        if (stable(record.data) !== row.ack && stable(record.data) !== stable(row.draft.data)) {
          row.conflict = true;
          conflicts++;
          await saveRow(row);
          continue;
        }
        record = await request(path, 'PUT', {
          expected_revision: record.revision,
          data: row.draft.data,
        });
        row.ack = stable(row.draft.data);
      } else {
        row.draft.data = record.data;
        row.ack = stable(record.data);
      }
      let bytes;
      for (const photo of row.draft.photos) {
        if (!record.photos.some((p) => p.id === photo.id)) {
          bytes ??= await photoBytes(row.key);
          record = await request(path + '/photos', 'POST', {
            photo_id: photo.id,
            expected_revision: record.revision,
            room: photo.room,
            captured_at: photo.captured_at,
            data_url: bytes.get(photo.id),
          });
        }
        Object.assign(
          photo,
          record.photos.find((p) => p.id === photo.id),
          { uploaded: true },
        );
        row.record = record;
        await saveRow(row);
        if (photo.ocr_status === 'pending') {
          try {
            record = await request(path + '/photos/' + photo.id + '/ocr', 'POST', {});
          } catch (e) {
            if (e.status === 429) throw e;
            record = await request(path);
          }
          Object.assign(
            photo,
            record.photos.find((p) => p.id === photo.id),
          );
        }
      }
      for (const photo of record.photos)
        if (!row.draft.photos.some((p) => p.id === photo.id))
          row.draft.photos.push({ ...photo, uploaded: true });
      row.record = record;
      await saveRow(row);
    }
    if (conflicts)
      say(
        conflicts === 1
          ? '1 queued draft changed on another device. Open it from Jobs to choose which version to keep.'
          : conflicts +
              ' queued drafts changed on another device. Open them from Jobs to choose which version to keep.',
        'error',
      );
    else if (canonical) await leaveForCanonical();
  } catch (e) {
    if (e.status === 429 && state.user?.uid === uid) {
      clearTimeout(state.queueRetry);
      state.queueRetry = setTimeout(() => drainQueue(), Math.max(1, e.retryAfter) * 1000);
    } else if (state.user?.uid === uid && navigator.onLine)
      say(
        'Some queued drafts still need synchronization. They remain on this device; reopen them to review or retry.',
        'error',
      );
  } finally {
    drainingQueue = false;
  }
}
function startOCR(photo) {
  const inspectionId = state.draft.inspection_id;
  if (state.ocr.has(photo.id)) return;
  const promise = (async () => {
    try {
      const record = await jsonApi(
        '/api/inspections/' + inspectionId + '/photos/' + photo.id + '/ocr',
        'POST',
        {},
      );
      absorb(record);
    } catch (e) {
      if (state.draft?.inspection_id === inspectionId) {
        if (e.status === 429) {
          say(
            'Recognition limit reached. Retry the pending photo after ' +
              e.retryAfter +
              ' seconds.',
            'error',
          );
        } else {
          say(
            'Photo recognition failed. The photo remains unverified; retry recognition or proceed without a verified reading.',
            'error',
          );
        }
        try {
          absorb(await jsonApi('/api/inspections/' + inspectionId));
        } catch {}
      }
    } finally {
      state.ocr.delete(photo.id);
      await persist();
      renderPhotos();
    }
  })();
  state.ocr.set(photo.id, promise);
}
function clearScopePreview() {
  state.scopePreview = null;
  $('scopeSuggestionPanel').hidden = true;
}
async function fillScopeFromWalkthrough() {
  if (ui.fillingScope || ui.auditing) return;
  if (!state.draft || state.signed || confirmedAuthorization)
    throw Error('Open an unsigned inspection first.');
  if (!navigator.onLine) throw Error('Reading the walkthrough requires a connection.');
  collect();
  clearScopePreview();
  ui.fillingScope = true;
  renderControls();
  say('Reading recorded observations…');
  const draft = state.draft,
    uid = state.user.uid;
  let version = state.localVersion;
  try {
    await stopWalk();
    version = state.localVersion;
    if (!draft.data.technician_transcript.trim() && !draft.data.technician_notes.trim())
      throw Error('Record technician observations in the walkthrough or notes first.');
    await syncDraft();
    if (state.draft !== draft || state.user?.uid !== uid || state.signed || confirmedAuthorization)
      return;
    if (state.conflict || !state.record || stable(draft.data) !== state.ack)
      throw Error('Finish saving or recover the draft before reading the walkthrough.');
    if (state.localVersion !== version)
      throw Error(
        'The draft changed while reading the walkthrough. Retry to use its current values.',
      );
    const revision = state.record.revision;
    const result = await jsonApi(
      '/api/inspections/' + draft.inspection_id + '/scope-suggestions',
      'POST',
      { inspection_id: draft.inspection_id, expected_revision: revision },
    );
    if (state.draft !== draft || state.user?.uid !== uid || state.signed || confirmedAuthorization)
      return;
    if (state.localVersion !== version || state.record.revision !== revision || state.conflict)
      throw Error(
        'The draft changed while reading the walkthrough. Retry to use its current values.',
      );
    if (result.inspection_id !== draft.inspection_id || result.revision !== revision)
      throw Error('Scope suggestions belong to a different draft. Retry.');
    state.scopePreview = { draft, uid, version, revision, groups: [] };
    const groups = new Map();
    for (const change of result.changes) {
      const key = change.room == null ? 'job:' + change.field : 'room:' + roomKey(change.room);
      if (!groups.has(key)) groups.set(key, { room: change.room, changes: [] });
      groups.get(key).changes.push(change);
    }
    const list = $('scopeSuggestionList');
    list.replaceChildren();
    const display = (value) =>
      value == null
        ? 'Not entered'
        : typeof value === 'boolean'
          ? value
            ? 'Yes'
            : 'No'
          : String(value);
    for (const group of groups.values()) {
      const row = node('div', undefined, 'scope-suggestion'),
        label = node('label', undefined, 'check'),
        input = node('input');
      input.type = 'checkbox';
      input.checked = true;
      const existing =
        group.room == null
          ? draft.data
          : draft.data.rooms.find((room) => roomKey(room.name) === roomKey(group.room));
      label.append(
        input,
        node(
          'strong',
          group.room == null
            ? scopeJobLabels[group.changes[0].field]
            : group.room + (existing ? '' : ' · New room'),
        ),
      );
      row.append(label);
      if (group.room != null && !existing)
        row.append(
          node(
            'p',
            'Unstated room fields retain the form defaults. Confirm every field before generating documents.',
            'hint',
          ),
        );
      for (const change of group.changes) {
        row.append(
          node(
            'p',
            (group.room == null ? '' : scopeRoomLabels[change.field] + ': ') +
              display(existing?.[change.field]) +
              ' → ' +
              display(change.value),
          ),
        );
        row.append(node('blockquote', change.source_quote));
      }
      list.append(row);
      state.scopePreview.groups.push({ ...group, input });
    }
    $('scopeQuestions').replaceChildren(
      ...result.questions.map((question) => node('li', question)),
    );
    $('scopeSuggestionStatus').textContent = result.changes.length
      ? 'Review the proposed changes and their source statements. Uncheck any you want to keep as entered.'
      : 'No explicit changes found. Add or clarify technician observations and try again.';
    $('applyScopeSuggestions').hidden = !result.changes.length;
    $('scopeSuggestionPanel').hidden = false;
    showTask('property');
    say(
      result.changes.length
        ? 'Review the proposed scope values before applying.'
        : 'No explicit changes found. Clarify your observations and retry.',
    );
  } finally {
    ui.fillingScope = false;
    renderControls();
  }
}
async function applyScopeSuggestions() {
  const preview = state.scopePreview;
  if (
    !preview ||
    state.draft !== preview.draft ||
    state.user?.uid !== preview.uid ||
    state.localVersion !== preview.version ||
    state.record?.revision !== preview.revision ||
    state.signed ||
    confirmedAuthorization ||
    state.conflict
  )
    throw Error('The draft changed. Read the walkthrough again before applying suggestions.');
  const changes = preview.groups
    .filter((group) => group.input.checked)
    .flatMap((group) => group.changes);
  if (!changes.length)
    throw Error('Select at least one change to apply, or dismiss the suggestions.');
  state.draft.data = applyScopeChanges(state.draft.data, changes);
  changed();
  fillForm();
  await persist();
  say(
    'Selected values filled. Review all Property & scope fields and confirm the scope before generating documents.',
    'success',
  );
}
function collect() {
  if (!state.draft) return;
  const data = state.draft.data;
  const mapping = {
    address: 'address',
    yearBuilt: 'year_built',
    airMovers: 'air_movers',
    dehumidifiers: 'dehumidifiers',
    dryingDays: 'drying_days',
    laborHours: 'labor_hours',
    emergencyCalls: 'emergency_calls',
    monitoringHours: 'monitoring_hours',
    haulLoads: 'haul_loads',
    airScrubbers: 'air_scrubbers',
    hepaFilters: 'hepa_filters',
    matterportScans: 'matterport_scans',
    dumpTruckLoads: 'dump_truck_loads',
    equipmentDecon: 'equipment_decon',
    powerDistribution: 'power_distribution',
    woodFloorSystems: 'wood_floor_systems',
    woodFloorDays: 'wood_floor_days',
    technicianNotes: 'technician_notes',
    technicianTranscript: 'technician_transcript',
  };
  for (const [id, key] of Object.entries(mapping)) {
    const el = $(id);
    data[key] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
  }
  data.package_price = null;
  for (const [id, key] of Object.entries({
    afterHours: 'is_after_hours',
    scopeConfirmed: 'scope_confirmed',
  }))
    data[key] = $(id).checked;
  window.WorkspaceUI?.scopeAddressChanged();
}
function fillForm() {
  clearScopePreview();
  const data = state.draft.data;
  if (!state.media) {
    $('transcriptStatus').textContent = data.capture_metadata
      ? 'Capture ' +
        data.capture_metadata.status +
        (data.capture_metadata.technician_edited ? ' · technician edited' : '') +
        ' · Review recorded observations.'
      : '';
    $('liveTranscriptPreview').textContent = '';
  }

  const defaults = emptyData();
  for (const [id, key] of Object.entries({
    address: 'address',
    yearBuilt: 'year_built',
    airMovers: 'air_movers',
    dehumidifiers: 'dehumidifiers',
    dryingDays: 'drying_days',
    laborHours: 'labor_hours',
    emergencyCalls: 'emergency_calls',
    monitoringHours: 'monitoring_hours',
    haulLoads: 'haul_loads',
    airScrubbers: 'air_scrubbers',
    hepaFilters: 'hepa_filters',
    matterportScans: 'matterport_scans',
    dumpTruckLoads: 'dump_truck_loads',
    equipmentDecon: 'equipment_decon',
    powerDistribution: 'power_distribution',
    woodFloorSystems: 'wood_floor_systems',
    woodFloorDays: 'wood_floor_days',
    technicianNotes: 'technician_notes',
    technicianTranscript: 'technician_transcript',
    assistantTranscript: 'assistant_transcript',
  }))
    $(id).value = data[key] ?? defaults[key] ?? '';
  for (const [id, key] of Object.entries({
    afterHours: 'is_after_hours',
    scopeConfirmed: 'scope_confirmed',
  }))
    $(id).checked = !!data[key];
  $('inspectionFields').disabled = !!state.signed || !!confirmedAuthorization || !state.session;
  renderRooms();
  renderPhotos();
  renderSaveStatus();
  renderControls();
}
function renderRooms() {
  clearValidationFeedback();
  $('inspectionForm').before($('validationFeedback'));
  $('rooms').replaceChildren();
  $('photoRoom').replaceChildren();
  state.draft.data.rooms.forEach((room, i) => {
    const card = node('div', undefined, 'room'),
      head = node('div', undefined, 'section-head');
    head.append(node('h3', 'Room ' + (i + 1)));
    const remove = button('Remove', () => requestRoomRemoval(room, remove));
    remove.disabled = !!state.signed || !!confirmedAuthorization;
    head.append(remove);
    card.append(head);
    const grid = node('div', undefined, 'form-grid');
    const definitions = [
      ['Room name', 'name', 'text'],
      ['Water category', 'category', 'select'],
      ['Unfinished / subfloor SF', 'unfinished_sf', 'number'],
      ['Finished / drywall / trim SF', 'finished_sf', 'number'],
      ['Waste %', 'waste_percent', 'number'],
    ];
    for (const [label, key, type] of definitions) {
      const wrap = node('label', label),
        input = node(type === 'select' ? 'select' : 'input');
      input.dataset.roomIndex = i;
      input.dataset.roomKey = key;
      if (type === 'select') {
        [
          [1, '1 · Clean water'],
          [2, '2 · Gray water'],
          [3, '3 · Contaminated / mold'],
        ].forEach(([value, text]) => {
          const opt = node('option', text);
          opt.value = value;
          input.append(opt);
        });
      } else {
        input.type = type;
        if (type === 'number') {
          input.min = 0;
          input.max = key === 'waste_percent' ? 100 : 100000;
          input.step = 0.01;
        } else input.maxLength = 100;
        input.required = true;
      }
      input.value = room[key];
      input.disabled = !!state.signed;
      input.addEventListener('input', () => {
        room[key] = type === 'text' ? input.value : Number(input.value);
        changed();
        if (key === 'name') updateRoomPicker();
      });
      wrap.append(input);
      grid.append(wrap);
    }
    card.append(grid);
    const check = node('label', undefined, 'check'),
      input = node('input');
    input.type = 'checkbox';
    input.checked = room.custom_cabinetry;
    input.disabled = !!state.signed;
    input.addEventListener('change', () => {
      room.custom_cabinetry = input.checked;
      changed();
    });
    check.append(input, node('span', 'Custom cabinetry · category 3 finished rate ×2'));
    card.append(check);
    $('rooms').append(card);
  });
  updateRoomPicker();
}
function requestRoomRemoval(room, trigger) {
  if (
    !state.session ||
    !state.draft ||
    state.signed ||
    confirmedAuthorization ||
    !state.draft.data.rooms.includes(room)
  )
    return;
  roomRemoval = { room, trigger, draft: state.draft, uid: state.user?.uid };
  $('removeRoomDescription').textContent =
    'Remove "' +
    (room.name.trim() || 'Unnamed room') +
    '"? Its measurements will be deleted, scope confirmation cleared, and generated documents and any unsigned signature invalidated. This cannot be undone.';
  $('removeRoomDialog').showModal();
  $('cancelRoomRemoval').focus();
}
function closeRoomRemoval() {
  const pending = roomRemoval;
  roomRemoval = null;
  if (!pending) return;
  if (pending.trigger.isConnected && !pending.trigger.disabled) focusAndReveal(pending.trigger);
}
function confirmRoomRemoval() {
  const pending = roomRemoval;
  if (
    !pending ||
    state.draft !== pending.draft ||
    state.user?.uid !== pending.uid ||
    !state.session ||
    state.signed ||
    confirmedAuthorization
  ) {
    $('removeRoomDialog').close();
    return;
  }
  const index = state.draft.data.rooms.indexOf(pending.room);
  if (index < 0) {
    $('removeRoomDialog').close();
    return;
  }
  roomRemoval = null;
  $('removeRoomDialog').close();
  clearValidationFeedback();
  state.draft.data.rooms.splice(index, 1);
  changed();
  renderRooms();
  const remaining = $('rooms').querySelector(
    '[data-room-index="' +
      Math.min(index, state.draft.data.rooms.length - 1) +
      '"][data-room-key="name"]',
  );
  focusAndReveal(remaining || $('addRoom'));
}
function updateRoomPicker() {
  const value = $('photoRoom').value;
  $('photoRoom').replaceChildren();
  for (const room of state.draft.data.rooms) {
    const opt = node('option', room.name);
    opt.value = room.name;
    $('photoRoom').append(opt);
  }
  if (state.draft.data.rooms.some((r) => r.name === value)) $('photoRoom').value = value;
}
function photoUrl(photo) {
  return photo.data_url || state.photoUrls.get(photo.id) || '';
}
function renderPhotos() {
  const photos = state.draft?.photos || [];
  $('photoCount').textContent =
    photos.length +
    ' photos · ' +
    photos.filter((p) => p.ocr_status === 'verified').length +
    ' verified';
  $('photoGallery').replaceChildren();
  if (!photos.length)
    $('photoGallery').append(node('p', 'Capture or upload evidence and choose its room.', 'empty'));
  for (const p of photos) {
    const figure = node('figure', undefined, 'photo'),
      image = node('img');
    image.alt = p.room + ' inspection photo';
    image.src = photoUrl(p);
    figure.append(image);
    const caption = node('figcaption');
    caption.append(
      node('strong', p.room),
      node('div', new Date(p.captured_at).toLocaleString()),
      node(
        'div',
        (p.width && p.height ? p.width + ' × ' + p.height + ' · ' : '') +
          p.ocr_status.replaceAll('_', ' '),
      ),
    );
    if (p.ocr_status === 'verified')
      caption.append(node('div', p.ocr.meter_type + ': ' + p.ocr.value));
    if (!state.signed && p.uploaded && ['failed', 'pending', 'no_meter'].includes(p.ocr_status))
      caption.append(button('Retry recognition', () => startOCR(p)));
    figure.append(caption);
    $('photoGallery').append(figure);
  }
  const verified = photos.filter((p) => p.ocr_status === 'verified').at(-1);
  $('captureStatus').textContent = verified
    ? verified.room + ' · ' + verified.ocr.meter_type + ': ' + verified.ocr.value
    : 'No reading verified.';
}
async function addPhoto(blob) {
  if (!state.draft || state.signed || confirmedAuthorization)
    throw Error('Open a draft before capturing evidence.');
  if (state.draft.photos.length >= 30) throw Error('An inspection can contain at most 30 photos.');
  if (blob.size > 8 * 1024 * 1024)
    throw Error('Photo exceeds 8 MB. Choose a smaller JPEG, PNG or WebP.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type))
    throw Error('Use JPEG, PNG or WebP; convert unsupported camera formats first.');
  const room = $('photoRoom').value;
  if (!room) throw Error('Add a room and choose its name before taking a photo.');
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width,
    height = bitmap.height;
  bitmap.close();
  if (width * height > 60000000) throw Error('Photo exceeds 60 megapixels.');
  const data_url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('Photo could not be read.'));
    reader.readAsDataURL(blob);
  });
  state.draft.photos.push({
    id: newId(),
    room,
    captured_at: new Date().toISOString(),
    data_url,
    width,
    height,
    ocr_status: 'pending',
    uploaded: false,
  });
  changed();
  renderPhotos();
  await syncDraft();
}
async function captureStill() {
  if (!state.media) {
    $('photoFileInput').click();
    return;
  }
  const track = state.media.getVideoTracks()[0];
  if (window.ImageCapture) {
    try {
      await addPhoto(await new ImageCapture(track).takePhoto());
      return;
    } catch (e) {
      say('Native still capture unavailable: ' + e.message + ' You can use Camera / upload.');
    }
  }
  const video = $('cameraVideo');
  if (!video.videoWidth) throw Error('The camera is not ready. Retry or use Camera / upload.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  await addPhoto(await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94)));
}
async function openNew(data = emptyData(), photos = []) {
  if (!state.session || !window.WorkspaceUI?.can('jobs_create'))
    throw Error('Company access is required before starting an inspection.');
  if (state.session?.workspaces_enabled && state.session.role === 'office') {
    data = { ...emptyData(), address: data.address, rooms: [] };
    photos = [];
  }
  const epoch = authEpoch;
  await stopWalk();
  await syncChain.catch(() => {});
  await persist();
  if (epoch !== authEpoch) return;
  for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
  state.photoUrls.clear();
  state.draft = {
    inspection_id: 'ADR-INS-' + newId(),
    data: structuredClone(data),
    photos: structuredClone(photos),
  };
  confirmedAuthorization = null;
  $('retrySavedEvidence').hidden = true;
  $('signedEvidenceStatus').textContent = '';
  state.record = null;
  state.ack = null;
  state.signed = null;
  state.documents = null;
  state.conflict = false;
  state.ocr.clear();
  state.localVersion++;
  $('conflictActions').hidden = true;
  $('savedSignature').hidden = true;
  $('signingArea').hidden = false;
  invalidate();
  fillForm();
  showTask('property', false);
  await persist();
  await syncDraft();
  await window.WorkspaceUI?.editor();
}
async function restoreDraft(id) {
  const epoch = authEpoch;
  await stopWalk();
  await syncChain.catch(() => {});
  await persist();
  const local = (await localDrafts()).find((r) => r.draft.inspection_id === id);
  if (local) {
    const bytes = await photoBytes(local.key);
    for (const photo of local.draft.photos)
      if (bytes.has(photo.id)) photo.data_url = bytes.get(photo.id);
  }
  let remote = null;
  if (navigator.onLine) {
    try {
      remote = await jsonApi('/api/inspections/' + id);
    } catch (e) {
      if (e.status !== 404 || !local) throw e;
    }
  }
  if (epoch !== authEpoch) return;
  for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
  state.photoUrls.clear();
  confirmedAuthorization = null;
  $('retrySavedEvidence').hidden = true;
  $('signedEvidenceStatus').textContent = '';
  state.signed = null;
  state.signature = null;
  state.pendingAuthorization = null;
  state.conflict = false;
  state.documents = null;
  state.draft = local
    ? local.draft
    : {
        inspection_id: id,
        data: remote.data,
        photos: remote.photos.map((p) => ({ ...p, uploaded: true })),
      };
  state.record = remote || local.record;
  state.ack = local ? local.ack : stable(remote.data);
  if (
    remote &&
    local &&
    stable(remote.data) !== local.ack &&
    stable(local.draft.data) !== stable(remote.data)
  ) {
    state.conflict = true;
    $('conflictActions').hidden = false;
    say('Your local draft and the saved revision differ. Choose which to restore.', 'error');
  } else {
    if (remote) {
      absorb(remote);
      if (!local || stable(local.draft.data) === local.ack) {
        state.draft.data = remote.data;
        state.ack = stable(remote.data);
      }
    }
    $('conflictActions').hidden = true;
  }
  state.documents = state.record?.audit?.documents || null;
  if (stable(state.draft.data) !== state.ack) state.documents = null;
  fillForm();
  await loadPhotoUrls('/api/inspections/' + id + '/photos/');
  renderDocuments();
  $('jobsDialog').close();
  showTask('property', false);
  if (remote?.status === 'signed') {
    await restoreSigned(remote.authorization_id);
    return;
  }
  await persist();
  await syncDraft();
  await window.WorkspaceUI?.editor();
}
async function loadPhotoUrls(prefix) {
  const draft = state.draft,
    uid = state.user.uid;
  for (const photo of draft.photos) {
    if (photo.data_url || !navigator.onLine) continue;
    try {
      const response = await api(prefix + photo.id),
        blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(Error('Photo could not be stored locally.'));
        reader.readAsDataURL(blob);
      });
      if (state.draft !== draft || state.user?.uid !== uid) return;
      photo.data_url = dataUrl;
    } catch (e) {
      say(
        'Some photos are unavailable on this device. Reconnect and reopen this job to retry.',
        'error',
      );
    }
  }
  if (state.draft === draft && state.user?.uid === uid) {
    await persist();
    renderPhotos();
  }
}
// Help is static text; role only orders the topics and never reveals data or controls.
const HELP_ROLES = {
  estimator: 'Estimator',
  office: 'Office staff',
  owner: 'Owner',
  superadmin: 'Superadmin',
};
function helpRoles() {
  const session = state.session;
  if (!state.user || !session) return [];
  // Without company workspaces every approved account runs the full field workflow.
  if (!session.workspaces_enabled) return ['estimator'];
  return [session.role, session.superadmin && 'superadmin'].filter((role) => HELP_ROLES[role]);
}
let helpContactDefault;
function helpContact() {
  const line = $('helpContact');
  helpContactDefault ??= [...line.childNodes].map((child) => child.cloneNode(true));
  line.hidden = false;
  if (!state.session?.workspaces_enabled) return line.replaceChildren(...helpContactDefault);
  // The same company details the Account menu shows once a workspace session loads.
  const profile = state.session.company?.profile;
  // A superadmin without a company membership is the platform contact; there is no one to name.
  if (!profile && state.session.superadmin) return (line.hidden = true);
  if (!profile) return line.replaceChildren('For company access, ask your company owner.');
  const parts = ['Need help with a job? Contact ' + profile.name];
  const phone = profile.phone?.replace(/[^\d+]/g, '');
  if (phone) parts.push(' at ', Object.assign(node('a', profile.phone), { href: 'tel:' + phone }));
  if (profile.email)
    parts.push(
      phone ? ' or ' : ' at ',
      Object.assign(node('a', profile.email), { href: 'mailto:' + profile.email }),
    );
  line.replaceChildren(...parts, '.');
}
let helpTopics;
function openHelp() {
  closeMenus();
  const roles = helpRoles();
  $('helpYours').hidden = !roles.length;
  $('helpYoursHeading').textContent =
    'For you: ' + roles.map((role) => HELP_ROLES[role]).join(' and ');
  $('helpOtherHeading').textContent = roles.length ? 'Other roles' : 'App features';
  $('helpIntro').textContent = roles.length
    ? 'How to use the field estimator. Topics for your role come first.'
    : 'How to use the field estimator. Sign in to see the topics for your role first.';
  helpTopics ??= [...document.querySelectorAll('#helpDialog [data-help-roles]')];
  for (const topic of helpTopics) {
    const yours = topic.dataset.helpRoles.split(' ').some((role) => roles.includes(role));
    $(yours ? 'helpYours' : 'helpOther').append(topic);
  }
  $('helpOther').hidden = !$('helpOther').querySelector('[data-help-roles]');
  $('helpDialog').querySelector('[data-help-topic="start"]').open = !roles.length;
  helpContact();
  $('helpDialog').showModal();
}
async function showJobs() {
  closeMenus();
  $('jobsDialog').showModal();
  $('jobsList').replaceChildren(node('p', 'Loading your private jobs…'));
  try {
    const local = await localDrafts(),
      remotePage = navigator.onLine ? await jsonApi('/api/inspections') : { inspections: [] },
      signedPage = navigator.onLine ? await jsonApi('/api/authorizations') : { authorizations: [] };
    const remote = remotePage.inspections,
      signed = signedPage.authorizations;
    const map = new Map(
      remote.filter((r) => r.status !== 'signed').map((r) => [r.inspection_id, r]),
    );
    for (const row of local) {
      if (row.record?.status === 'signed') continue;
      map.set(row.draft.inspection_id, {
        inspection_id: row.draft.inspection_id,
        address: row.draft.data.address,
        status: 'draft',
        updated_at: row.updated_at,
      });
    }
    $('jobsList').replaceChildren();
    for (const r of map.values())
      $('jobsList').append(
        Object.assign(
          button(
            (r.address || 'Untitled inspection') +
              '\nDraft · ' +
              new Date(r.updated_at).toLocaleString(),
            () => restoreDraft(r.inspection_id),
          ),
          { className: 'job-link' },
        ),
      );
    for (const r of signed)
      $('jobsList').append(
        Object.assign(
          button(
            r.address +
              '\nSigned · ' +
              estimateLabel(r) +
              ' · ' +
              new Date(r.created_at).toLocaleDateString(),
            () => restoreSigned(r.auth_id),
          ),
          { className: 'job-link' },
        ),
      );
    const seen = new Set([...map.keys(), ...signed.map((r) => r.auth_id)]),
      uid = state.user.uid;
    const more = (path, key, cursor, label) => {
      if (!cursor) return;
      const control = button(label, async () => {
        control.disabled = true;
        try {
          const page = await jsonApi(path + '?cursor=' + encodeURIComponent(cursor));
          if (state.user?.uid !== uid) return;
          for (const r of page[key]) {
            const id = key === 'inspections' ? r.inspection_id : r.auth_id;
            if (seen.has(id) || (key === 'inspections' && r.status === 'signed')) continue;
            seen.add(id);
            const entry =
              key === 'inspections'
                ? button(
                    (r.address || 'Untitled inspection') +
                      '\nDraft · ' +
                      new Date(r.updated_at).toLocaleString(),
                    () => restoreDraft(id),
                  )
                : button(
                    r.address +
                      '\nSigned · ' +
                      estimateLabel(r) +
                      ' · ' +
                      new Date(r.created_at).toLocaleDateString(),
                    () => restoreSigned(id),
                  );
            entry.className = 'job-link';
            control.before(entry);
          }
          cursor = page.next_cursor;
          control.hidden = !cursor;
        } finally {
          control.disabled = false;
        }
      });
      $('jobsList').append(control);
    };
    more('/api/inspections', 'inspections', remotePage.next_cursor, 'Load older drafts');
    more('/api/authorizations', 'authorizations', signedPage.next_cursor, 'Load older signed jobs');
    if (!map.size && !signed.length)
      $('jobsList').append(node('p', 'No jobs saved yet. Start a new inspection.'));
  } catch (e) {
    $('jobsList').replaceChildren(node('p', e.message));
  }
}
async function restoreSigned(id) {
  const uid = state.user?.uid;
  await stopWalk();
  await persist();
  const record = await jsonApi('/api/authorizations/' + encodeURIComponent(id));
  if (state.user?.uid !== uid) return;
  if (record.inspection_id) await deleteDraft(draftKey(record.inspection_id));
  if (state.user?.uid !== uid) return;
  state.signed = record;
  state.record = null;
  state.ack = null;
  state.signature = null;
  state.pendingAuthorization = null;
  confirmedAuthorization = id;
  state.draft = {
    inspection_id: record.inspection_id || '',
    data: { ...emptyData(), ...record.inspection, address: record.address },
    photos: record.photos.map((p, i) => ({
      ...p,
      id: p.id || String(i),
      room: p.room || 'Historical evidence',
      captured_at: p.captured_at || p.timestamp,
      uploaded: true,
    })),
  };
  state.documents = record.documents || {
    adr_estimate: {
      property_address: record.address,
      date: record.date,
      proposed_cost: record.proposed_cost,
      findings: record.findings || [],
      recommendations: record.recommendations || [],
      disclaimers: [],
    },
    xactimate_scope: record.xactimate_scope || [],
    xactimate_total: (record.xactimate_scope || []).reduce((n, i) => n + Number(i.total || 0), 0),
    iicrc_defense_letter: 'Historical agreement: no defense letter was stored in this record.',
    photo_audit_log: [],
    ai_summary: '',
    ai_suggestions: [],
    unpriced_work: [],
    signable: false,
  };
  $('savedSignature').hidden = true;
  fillForm();
  renderDocuments();
  showTask('review');
  $('jobsDialog').close();
  await window.WorkspaceUI?.editor();
  const draft = state.draft,
    current = () => state.user?.uid === uid && state.signed === record && state.draft === draft;
  let missing = 0;
  for (let i = 0; i < record.photos.length; i++) {
    try {
      const response = await api(
          '/api/authorizations/' + encodeURIComponent(id) + '/evidence/photo-' + i,
        ),
        blob = await response.blob();
      if (!current()) return;
      const photoId = draft.photos[i].id,
        old = state.photoUrls.get(photoId);
      if (old) URL.revokeObjectURL(old);
      state.photoUrls.set(photoId, URL.createObjectURL(blob));
    } catch {
      missing++;
    }
  }
  try {
    const signature = await api(
        '/api/authorizations/' + encodeURIComponent(id) + '/evidence/signature',
      ),
      blob = await signature.blob();
    if (!current()) return;
    if ($('savedSignature').src.startsWith('blob:')) URL.revokeObjectURL($('savedSignature').src);
    $('savedSignature').src = URL.createObjectURL(blob);
    $('savedSignature').hidden = false;
  } catch {
    missing++;
  }
  if (!current()) return;
  renderPhotos();
  renderDocuments();
  $('retrySavedEvidence').hidden = !missing;
  $('signedEvidenceStatus').textContent =
    (missing
      ? 'Signed agreement saved. Some evidence could not be displayed. Retry loading saved evidence.'
      : 'Signed agreement and evidence restored.') +
    (record.signer
      ? ' Signed through the homeowner link by ' +
        record.signer.name +
        (record.signer.role === 'owner' ? ' (owner).' : ' (authorized representative).')
      : '');
  say(
    missing
      ? 'Signed agreement saved; evidence display needs a retry.'
      : 'Signed agreement restored. The original cannot be edited.',
    missing ? 'error' : 'success',
  );
}
async function finishAudit() {
  if (!state.draft || state.signed || confirmedAuthorization)
    throw Error('Open an unsigned draft first.');
  collect();
  clearValidationFeedback();
  if (!$('inspectionForm').checkValidity()) {
    showTask('property', false);
    const form = $('inspectionForm'),
      invalid = form.querySelector(':invalid:not(fieldset)');
    // Retain native constraints/messages, but replace the WebKit bubble that can cover inline feedback.
    const inlineOnly = (event) => event.preventDefault();
    form.addEventListener('invalid', inlineOnly, true);
    try {
      form.reportValidity();
    } finally {
      form.removeEventListener('invalid', inlineOnly, true);
    }
    showValidationFeedback(invalid);
    return;
  }
  if (!state.draft.data.scope_confirmed) {
    showTask('property', false);
    showValidationFeedback(
      $('scopeConfirmed'),
      'Confirm all scope and pricing inputs before auditing.',
    );
    return;
  }
  await stopWalk();
  ui.auditing = true;
  renderControls();
  try {
    await syncDraft();
    if (
      state.conflict ||
      !state.record ||
      stable(state.draft.data) !== state.ack ||
      state.draft.photos.some((p) => !p.uploaded)
    )
      throw Error('Finish saving the draft and its photos before auditing.');
    const until = Date.now() + 30000;
    while (state.ocr.size && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 200));
    const record = await jsonApi('/api/inspections/' + state.draft.inspection_id);
    absorb(record);
    const version = state.localVersion;
    say('Generating documents from the confirmed inspection…');
    const audited = await jsonApi('/api/audit', 'POST', {
      inspection_id: state.draft.inspection_id,
      expected_revision: state.record.revision,
    });
    absorb(audited);
    if (version !== state.localVersion)
      throw Error('The inspection changed during generation. Audit the latest revision.');
    state.documents = audited.audit.documents;
    clearSignature();
    clearSigningError('documentsConfirmedError');
    state.pendingAuthorization = null;
    await persist();
    renderDocuments();
    say(
      state.documents.signable
        ? 'Audit ready. Review all four documents before signing.'
        : 'Audit requires correction: unresolved evidence or unpriced work remains.',
      state.documents.signable ? 'success' : 'error',
    );
    showTask('review');
  } catch (e) {
    invalidate();
    throw e;
  } finally {
    ui.auditing = false;
    renderControls();
  }
}
function renderDocuments() {
  const docs = state.documents;
  document.body.classList.toggle('has-documents', !!docs);
  $('documents').hidden = !docs;
  $('reviewEmpty').hidden = !!docs;
  if (!docs) return;
  if (ui.documentSource !== docs) {
    ui.documentSource = docs;
    ui.viewed.clear();
    selectDocument('proposal');
  }
  ADRDocuments.render(docs, state.draft.photos, photoUrl);
  $('signingArea').hidden = !!state.signed || !!confirmedAuthorization;
  $('authorizeJob').disabled = !!confirmedAuthorization || !docs.signable || !navigator.onLine;
  $('sendHomeownerLink').disabled = $('authorizeJob').disabled;
  if (state.signed || confirmedAuthorization) stopHomeownerLink();
  else if (ui.task === 'review') restoreHomeownerLink().catch(() => {});
  resizeSignature();
  window.WorkspaceUI?.documentBranding();
}
function resizeSignature() {
  const canvas = $('signCanvas'),
    rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const saved = state.signature;
  canvas.width = Math.round(rect.width * devicePixelRatio);
  canvas.height = Math.round(180 * devicePixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  if (saved) {
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, rect.width, 180);
    image.src = saved;
  }
}
function clearSigningError(id) {
  const error = $(id);
  error.textContent = '';
  error.hidden = true;
  $(id === 'signatureError' ? 'signCanvas' : 'documentsConfirmed').removeAttribute('aria-invalid');
}
function signingError(id, text, control) {
  const error = $(id);
  error.textContent = text;
  error.hidden = false;
  $(id === 'signatureError' ? 'signCanvas' : 'documentsConfirmed').setAttribute(
    'aria-invalid',
    'true',
  );
  focusAndReveal(control, error);
}
function clearSignature() {
  const canvas = $('signCanvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  state.signature = null;
  state.pendingAuthorization = null;
  $('authorizationStatus').textContent = '';
  clearSigningError('signatureError');
  if (!state.signed) $('savedSignature').hidden = true;
}
function initSignature() {
  const canvas = $('signCanvas');
  let drawing = false,
    moved = false;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (state.signed || confirmedAuthorization || !state.documents?.signable) return;
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    moved = false;
    const p = point(e),
      ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    state.pendingAuthorization = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e),
      ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    moved = true;
  });
  const end = () => {
    if (drawing && moved) {
      state.signature = canvas.toDataURL('image/png');
      clearSigningError('signatureError');
    }
    drawing = false;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  new ResizeObserver(() => resizeSignature()).observe(canvas);
}
async function authorize() {
  if (confirmedAuthorization) return restoreSigned(confirmedAuthorization);
  if (!navigator.onLine) throw Error('Signing requires a connection.');
  if (!state.signature) {
    signingError(
      'signatureError',
      'Have the homeowner or representative draw a signature in the pad before authorizing.',
      $('clearSignature'),
    );
    return;
  }
  clearSigningError('signatureError');
  if (!$('documentsConfirmed').checked) {
    signingError(
      'documentsConfirmedError',
      'Confirm all four documents were reviewed with the homeowner or representative before signing.',
      $('documentsConfirmed'),
    );
    return;
  }
  clearSigningError('documentsConfirmedError');
  if (!state.documents?.signable || !state.record?.audit)
    throw Error('Complete a valid current audit before signing.');
  const payload = state.pendingAuthorization || {
    inspection_id: state.draft.inspection_id,
    expected_revision: state.record.revision,
    auth_id: 'ADR-AUTH-' + crypto.randomUUID(),
    proposal_hash: state.record.audit.proposal_hash,
    signature_png: state.signature,
    documents_confirmed: true,
  };
  state.pendingAuthorization = payload;
  $('authorizeJob').disabled = true;
  $('authorizationStatus').textContent = 'Saving signed agreement…';
  try {
    const receipt = await jsonApi('/api/authorize', 'POST', payload);
    if (receipt.status !== 'success' || receipt.auth_id !== payload.auth_id)
      throw Error('Save confirmation was incomplete. Retry with the same reference.');
    confirmedAuthorization = receipt.auth_id;
    state.pendingAuthorization = null;
    renderSaveStatus();
    renderControls();
    renderDocuments();
    $('inspectionFields').disabled = true;
    $('authorizationStatus').textContent = 'Saved & signed · ' + receipt.auth_id;
    try {
      await restoreSigned(receipt.auth_id);
    } catch (e) {
      $('retrySavedEvidence').hidden = false;
      $('signedEvidenceStatus').textContent =
        'Signed agreement saved · ' + receipt.auth_id + '. Retry loading saved evidence.';
      say(
        'Signed agreement saved. Its display could not be restored; retry loading saved evidence.',
        'error',
      );
    }
  } catch (e) {
    $('authorizationStatus').textContent =
      'Save not confirmed: ' + e.message + ' Retry uses the same authorization reference.';
    e.saveNotConfirmed = true;
    throw e;
  } finally {
    $('authorizeJob').disabled =
      !!confirmedAuthorization || !!state.signed || !state.documents?.signable;
    window.WorkspaceUI?.policy();
  }
}
function stopHomeownerLink(status = '') {
  clearInterval(homeownerLink.timer);
  Object.assign(homeownerLink, { inspection: null, url: '', timer: null });
  $('homeownerLinkPanel').hidden = true;
  $('homeownerQr').removeAttribute('src');
  $('homeownerLinkUrl').value = '';
  $('homeownerLinkStatus').textContent = status;
}
// The server returns the link itself only when it is created; a restored link shows its status.
function showHomeownerLink(inspection, link) {
  stopHomeownerLink();
  Object.assign(homeownerLink, { inspection, url: link.url || '' });
  if (link.url) $('homeownerQr').src = link.qr_svg;
  $('homeownerLinkUrl').value = homeownerLink.url;
  for (const id of ['homeownerQr', 'copyHomeownerLink']) $(id).hidden = !link.url;
  $('homeownerLinkUrl').closest('label').hidden = !link.url;
  $('shareHomeownerLink').hidden = !link.url || !navigator.share;
  $('homeownerLinkPanel').hidden = false;
  $('homeownerLinkStatus').textContent =
    'Waiting for the homeowner to sign · the link expires ' +
    new Date(link.expires_at).toLocaleString() +
    '. Editing anything here cancels it.' +
    (link.url ? '' : ' Send a new link to show its QR code again.');
  homeownerLink.timer = setInterval(() => checkHomeownerLink().catch(() => {}), 10000);
}
// Once per displayed audit, the Review tab picks up a link sent before a reload or job switch.
async function restoreHomeownerLink() {
  const inspection = state.draft?.inspection_id,
    documents = state.documents;
  if (
    !inspection ||
    !documents?.signable ||
    state.signed ||
    confirmedAuthorization ||
    !navigator.onLine ||
    homeownerLink.inspection === inspection ||
    homeownerLink.checked === documents
  )
    return;
  homeownerLink.checked = documents;
  let link;
  try {
    link = await jsonApi('/api/inspections/' + inspection + '/signing-links');
  } catch (e) {
    if (homeownerLink.checked === documents) homeownerLink.checked = null;
    throw e;
  }
  if (
    link.status !== 'pending' ||
    homeownerLink.inspection ||
    state.draft?.inspection_id !== inspection ||
    state.documents !== documents
  )
    return;
  showHomeownerLink(inspection, link);
}
async function sendHomeownerLink() {
  if (!navigator.onLine) throw Error('Sending a signing link requires a connection.');
  if (!state.documents?.signable || !state.record?.audit)
    throw Error('Complete a valid current audit before sending a signing link.');
  const inspection = state.draft.inspection_id,
    documents = state.documents;
  $('sendHomeownerLink').disabled = true;
  $('homeownerLinkStatus').textContent = 'Creating a signing link…';
  try {
    const link = await jsonApi('/api/inspections/' + inspection + '/signing-links', 'POST', {
      expected_revision: state.record.revision,
      proposal_hash: state.record.audit.proposal_hash,
    });
    if (state.draft?.inspection_id !== inspection || state.documents !== documents) return;
    // A new link replaces the previous one on the server as well.
    showHomeownerLink(inspection, link);
  } catch (e) {
    $('homeownerLinkStatus').textContent = 'No link was created: ' + e.message;
    throw e;
  } finally {
    $('sendHomeownerLink').disabled =
      !!confirmedAuthorization || !state.documents?.signable || !navigator.onLine;
  }
}
// Polls only while a link is outstanding and the Review tab is in view.
async function checkHomeownerLink() {
  const inspection = homeownerLink.inspection;
  if (!inspection || document.hidden || ui.task !== 'review' || !navigator.onLine) return;
  const remote = await jsonApi('/api/inspections/' + inspection);
  if (homeownerLink.inspection !== inspection || state.draft?.inspection_id !== inspection) return;
  if (remote.status === 'signed') {
    stopHomeownerLink();
    await restoreSigned(remote.authorization_id);
    say('The homeowner signed the estimate.', 'success');
  } else if (remote.revision !== state.record?.revision)
    stopHomeownerLink('The inspection changed, so the signing link no longer works.');
}
async function revokeHomeownerLink() {
  const inspection = homeownerLink.inspection;
  if (!inspection) return;
  const result = await jsonApi('/api/inspections/' + inspection + '/signing-links/revoke', 'POST');
  if (homeownerLink.inspection !== inspection) return;
  if (result.status === 'used') return checkHomeownerLink();
  stopHomeownerLink('Signing link revoked. Send a new link or sign on this device.');
}
async function copyHomeownerLink() {
  try {
    await navigator.clipboard.writeText(homeownerLink.url);
    say('Signing link copied.', 'success');
  } catch {
    $('homeownerLinkUrl').select();
    throw Error('Clipboard access failed. The link is selected; copy it from the field.');
  }
}
async function shareHomeownerLink() {
  try {
    await navigator.share({ title: 'Estimate to review and sign', url: homeownerLink.url });
  } catch (e) {
    if (e.name !== 'AbortError') throw Error('Sharing failed. Copy the link instead.');
  }
}
function scopeJson() {
  if (!state.documents) throw Error('Generate or open a saved audit first.');
  return JSON.stringify(state.documents.xactimate_scope, null, 2);
}
async function copyJson() {
  try {
    await navigator.clipboard.writeText(scopeJson());
    say('Scope JSON copied.', 'success');
  } catch {
    throw Error('Clipboard access failed. Use Download scope JSON instead.');
  }
}
function downloadJson() {
  const url = URL.createObjectURL(new Blob([scopeJson()], { type: 'application/json' })),
    link = node('a');
  link.href = url;
  link.download = 'ADR-scope.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function bytes64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}
function clearPlayback() {
  for (const source of state.playing) {
    try {
      source.stop();
    } catch {}
  }
  state.playing.clear();
  state.audioTime = 0;
  state.firstAudio = true;
}
function playback(data) {
  if (!state.audio) return;
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    values = pcmToFloat(bytes),
    buffer = state.audio.createBuffer(1, values.length, 24000);
  buffer.copyToChannel(values, 0);
  if (state.audioTime - state.audio.currentTime > 5) clearPlayback();
  const source = state.audio.createBufferSource();
  source.buffer = buffer;
  source.connect(state.audio.destination);
  state.playing.add(source);
  source.onended = () => state.playing.delete(source);
  const start = Math.max(state.audio.currentTime + 0.025, state.audioTime);
  source.start(start);
  state.audioTime = start + buffer.duration;
  if (state.firstAudio && state.lastSpeech) {
    $('latencyStatus').textContent =
      'First response audio: ' +
      ((performance.now() - state.lastSpeech) / 1000).toFixed(2) +
      ' s after last detected speech (approximate).';
    state.firstAudio = false;
  }
}
function captureGap(message) {
  const capture = state.draft?.data.capture_metadata;
  if (!capture) return;
  capture.gap_count = Math.min(1000000, capture.gap_count + 1);
  capture.status = 'incomplete';
  changed(false);
  $('transcriptStatus').textContent = message;
}
const LIVE_TOKEN_REFRESH_MS = 600000;
async function refreshLiveToken(socket, uid) {
  // The relay re-verifies the newest token, so a session outlives the hour-long ID token without reconnecting.
  // A failed refresh is not fatal: at expiry the relay closes and the normal reconnect path recovers.
  try {
    const token = await state.user.getIdToken(true);
    if (state.socket === socket && state.user?.uid === uid && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'refresh', token }));
  } catch {}
}
async function connectLive() {
  if (state.stopping || !state.media) return;
  $('liveStatus').textContent = 'Connecting to live guidance…';
  $('liveStatus').className = 'status';
  const url = new URL(state.session.live_url);
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== 'alert-disaster-field-estimator-545776254070.us-west2.run.app'
  )
    throw Error('Unexpected Live endpoint.');
  const draft = state.draft,
    user = state.user,
    uid = user.uid,
    capture = draft.data.capture_metadata;
  // A cached token can be seconds from expiry; the relay then holds a fresh one for the full hour.
  const [token, appCheckValue] = await Promise.all([
    user.getIdToken(true).catch(() => user.getIdToken()),
    appCheckToken(),
  ]);
  if (state.stopping || !state.media || state.draft !== draft || state.user?.uid !== uid) return;
  const socket = new WebSocket(url);
  state.socket = socket;
  state.draining = false;
  socket.onopen = () =>
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        token,
        workspace_protocol_version: 1,
        inspection_id: draft.inspection_id,
        protocol_version: 2,
        capture_id: capture.capture_id,
        resume: !!state.resumeAvailable,
        ...(appCheckValue ? { app_check: appCheckValue } : {}),
      }),
    );
  socket.onmessage = (event) => {
    if (state.socket !== socket || state.draft !== draft || state.user?.uid !== uid) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'ready') {
      state.liveProtocol = msg.protocol_version || 1;
      state.liveReady = true;
      state.liveConnection = msg.connection_id || 'legacy';
      clearTimeout(state.stableTimer);
      state.stableTimer = setTimeout(() => {
        if (state.socket === socket && !state.stopping) state.retries = 0;
      }, 60000);
      clearInterval(state.tokenTimer);
      if (msg.token_refresh)
        state.tokenTimer = setInterval(() => refreshLiveToken(socket, uid), LIVE_TOKEN_REFRESH_MS);
      $('liveStatus').textContent =
        msg.recovery === 'resumed'
          ? 'Live conversation resumed'
          : msg.recovery === 'restarted'
            ? 'Live restarted using saved inspection'
            : 'Live AI connected';
      $('liveStatus').className = 'status connected';
      if (state.resumeAvailable) {
        capture.recovery_count = Math.min(10000, capture.recovery_count + 1);
        captureGap(
          'Conversation recovered. Review transcript boundaries and any missing observations.',
        );
      }
      state.resumeAvailable = true;
    } else if (msg.type === 'audio') {
      if (!state.draining && !state.stopping) playback(msg.data);
    } else if (msg.type === 'interrupted') clearPlayback();
    else if (msg.type === 'turn_complete') state.firstAudio = true;
    else if (msg.type === 'transcript') {
      if (state.liveProtocol === 1) {
        msg.connection_id = state.liveConnection;
        msg.sequence = (state.legacySequence || 0) + 1;
        state.legacySequence = msg.sequence;
      }
      const result = ingestTranscript(draft.data, msg);
      if (result.changed) {
        $(msg.speaker === 'technician' ? 'technicianTranscript' : 'assistantTranscript').value =
          draft.data[
            msg.speaker === 'technician' ? 'technician_transcript' : 'assistant_transcript'
          ];
        changed();
      }
      if (result.limit) {
        say(
          'Transcript storage is full. Capture stopped; review the saved observations and add missing details in notes.',
          'error',
        );
        stopWalk();
      } else if (result.preview)
        $('liveTranscriptPreview').textContent =
          (msg.speaker === 'technician' ? 'Technician' : 'Assistant') +
          ' — recognizing: ' +
          msg.text;
      else $('liveTranscriptPreview').textContent = '';
    } else if (msg.type === 'finished') {
      state.finishComplete = msg.complete;
      state.finishResolve?.();
    } else if (msg.type === 'recovery') {
      $('liveStatus').textContent = 'Refreshing Live connection…';
    } else if (msg.type === 'usage') {
      state.liveUsage = msg.total_tokens;
    } else if (msg.type === 'error') {
      say(msg.message, 'error');
      if (window.WorkspaceUI?.enabled() && [401, 403, 404].includes(msg.status)) {
        state.resumeAvailable = false;
        stopWalk({ drain: false });
        queueMicrotask(() => WorkspaceUI.refresh().catch((e) => say(e.message, 'error')));
      }
    }
  };
  socket.onerror = () =>
    say(
      'Live guidance could not connect. Your draft is preserved; check the connection and retry.',
      'error',
    );
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.liveReady = false;
    clearTimeout(state.stableTimer);
    clearInterval(state.tokenTimer);
    clearPlayback();
    state.finishResolve?.();
    $('liveStatus').textContent = 'Live AI disconnected';
    $('liveStatus').className = 'status';
    if (!state.stopping && state.media && navigator.onLine) {
      captureGap('Connection interrupted. Review the transcript for missing observations.');
      if (state.retries < 3) {
        const delay = [2000, 4000, 8000][state.retries++];
        state.reconnectTimer = setTimeout(
          () =>
            connectLive().catch((e) => {
              say(e.message, 'error');
              stopWalk({ preserveResume: true, drain: false });
            }),
          delay,
        );
      } else {
        say('Live could not recover. Tap Resume walkthrough to retry.', 'error');
        stopWalk({ preserveResume: true, drain: false });
      }
    }
  };
}
async function startWalk() {
  if (!state.session || !state.draft || state.signed)
    throw Error('Sign in and open an unsigned inspection first.');
  if (!navigator.onLine) throw Error('Live guidance requires a connection.');
  if (ui.starting || state.stopPromise) return;
  ui.starting = true;
  renderControls();
  const resume = !!state.resumeAvailable,
    draft = state.draft,
    uid = state.user.uid;
  await stopWalk({ preserveResume: resume, drain: false });
  state.stopping = false;
  state.muted = false;
  state.retries = 0;
  state.legacySequence = 0;
  if (!resume || !draft.data.capture_metadata) {
    draft.data.capture_metadata = {
      capture_id: newId(),
      status: 'recording',
      gap_count: 0,
      recovery_count: 0,
      technician_edited: false,
      segments: [],
    };
    changed(false);
  } else if (draft.data.capture_metadata.status === 'complete')
    draft.data.capture_metadata.status = 'recording';
  try {
    await syncDraft();
    if (state.draft !== draft || state.user?.uid !== uid || state.stopping) return;
    if (!state.record || state.conflict)
      throw Error('Save or recover the draft before starting live guidance.');
    const media = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (state.stopping || state.draft !== draft || state.user?.uid !== uid) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    state.media = media;
    $('cameraVideo').srcObject = media;
    // The preview must not gate Live: play() can stay pending indefinitely, and frames are skipped until the video has dimensions.
    $('cameraVideo')
      .play()
      .then(
        () => {
          if (state.media === media) $('cameraEmpty').hidden = true;
        },
        (e) => {
          if (state.media === media)
            say(
              'Camera preview could not start: ' +
                e.message +
                ' Live voice guidance continues; use Camera / upload for photos.',
              'error',
            );
        },
      );
    $('liveStatus').textContent = 'Connecting live guidance…';
    renderControls();
    state.audio = new (window.AudioContext || window.webkitAudioContext)();
    await state.audio.resume();
    if (state.stopping || state.draft !== draft || state.user?.uid !== uid) return;
    await state.audio.audioWorklet.addModule('/audio-worklet.js?v=unstamped');
    if (state.stopping || state.draft !== draft || state.user?.uid !== uid) return;
    const source = state.audio.createMediaStreamSource(media);
    state.node = new AudioWorkletNode(state.audio, 'adr-microphone');
    source.connect(state.node);
    state.node.connect(state.audio.destination);
    state.node.port.onmessage = (event) => {
      if (event.data.rms > 0.015) state.lastSpeech = performance.now();
      if (
        !state.muted &&
        state.liveReady &&
        !state.stopping &&
        state.socket?.readyState === WebSocket.OPEN
      ) {
        if (state.socket.bufferedAmount < 128000) {
          state.socket.send(
            JSON.stringify({ type: 'audio', data: bytes64(new Uint8Array(event.data.buffer)) }),
          );
          state.lastGap = false;
        } else if (!state.lastGap) {
          state.lastGap = true;
          captureGap(
            'Audio was interrupted by network congestion. Review and repeat missing measurements.',
          );
        }
      }
    };
    state.frameTimer = setInterval(() => {
      const video = $('cameraVideo');
      if (
        !state.liveReady ||
        state.stopping ||
        !video.videoWidth ||
        state.socket?.readyState !== WebSocket.OPEN ||
        state.socket.bufferedAmount > 128000
      )
        return;
      const canvas = $('frameCanvas');
      [canvas.width, canvas.height] = aspect(video.videoWidth, video.videoHeight, 1280);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      state.socket.send(
        JSON.stringify({ type: 'video', data: canvas.toDataURL('image/jpeg', 0.65).split(',')[1] }),
      );
    }, 1000);
    await connectLive();
  } catch (e) {
    await stopWalk({ preserveResume: true, drain: false });
    $('cameraEmpty').hidden = false;
    throw Error(
      'Camera / microphone could not start: ' +
        e.message +
        ' Retry permissions or use Camera / upload.',
    );
  } finally {
    ui.starting = false;
    renderControls();
  }
}
async function stopWalk(options = {}) {
  if (state.stopPromise) return state.stopPromise;
  const operation = async () => {
    const preserve = !!options.preserveResume,
      socket = state.socket,
      draft = state.draft,
      hadCapture = !!(socket || state.media || state.node);
    state.stopping = true;
    state.draining = true;
    state.liveReady = false;
    state.finishComplete = false;
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.stableTimer);
    clearInterval(state.tokenTimer);
    clearInterval(state.frameTimer);
    state.frameTimer = null;
    clearPlayback();
    if (state.node) {
      state.node.disconnect();
      state.node = null;
    }
    if (state.media) {
      state.media.getTracks().forEach((track) => track.stop());
      state.media = null;
    }
    if (state.audio) {
      await state.audio.close().catch(() => {});
      state.audio = null;
    }
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          let drain;
          if (state.liveProtocol === 2 && options.drain !== false)
            drain = new Promise((resolve) => {
              state.finishResolve = resolve;
              state.drainTimer = setTimeout(resolve, 3500);
            });
          socket.send(JSON.stringify({ type: 'end', preserve_resume: preserve }));
          if (drain) await drain;
        }
        socket.close();
      } catch {}
      if (state.socket === socket) state.socket = null;
    }
    clearTimeout(state.drainTimer);
    state.finishResolve = null;
    const capture = draft?.data.capture_metadata;
    if (capture && hadCapture && state.draft === draft) {
      if (capture.status !== 'truncated')
        capture.status = state.finishComplete && !capture.gap_count ? 'complete' : 'incomplete';
      changed(false);
      $('transcriptStatus').textContent =
        capture.status === 'complete'
          ? 'Transcript capture completed.'
          : 'Transcript capture needs review for unfinished or interrupted observations.';
    }
    state.resumeAvailable = preserve && !!capture;
    state.draining = false;
    $('cameraVideo').srcObject = null;
    $('cameraEmpty').hidden = false;
    $('liveStatus').textContent = 'Not connected';
    $('liveStatus').className = 'status';
    $('muteMic').textContent = 'Mute microphone';
    $('liveTranscriptPreview').textContent = '';
    $('cameraVideo').classList.remove('thermal-emulation');
    $('thermalBadge').hidden = true;
    $('thermalToggle').textContent = 'Color emulation';
    renderControls();
  };
  state.stopPromise = operation();
  try {
    await state.stopPromise;
  } finally {
    state.stopPromise = null;
  }
}
function mute() {
  state.muted = !state.muted;
  state.media?.getAudioTracks().forEach((track) => (track.enabled = !state.muted));
  if (state.muted && state.liveProtocol === 2 && state.socket?.readyState === WebSocket.OPEN)
    state.socket.send(JSON.stringify({ type: 'pause' }));
  $('muteMic').textContent = state.muted ? 'Unmute microphone' : 'Mute microphone';
}
function connectivity() {
  const offline = !navigator.onLine;
  $('offlineBanner').hidden = !offline;
  $('authorizeJob').disabled =
    offline || !!confirmedAuthorization || !state.documents?.signable || !!state.signed;
  $('sendHomeownerLink').disabled = $('authorizeJob').disabled;
  renderControls();
  renderSaveStatus();
  if (offline) {
    if (state.media)
      captureGap(
        'Connection went offline. Tap Resume walkthrough when online and review missing observations.',
      );
    stopWalk({ preserveResume: true, drain: false });
  } else
    Promise.resolve(window.WorkspaceUI?.refresh())
      .then(() => syncDraft())
      .then(() => drainQueue())
      .catch((e) => say(e.message, 'error'));
}
const unsynced = (row) =>
  row.conflict || stable(row.draft.data) !== row.ack || row.draft.photos.some((p) => !p.uploaded);
const canonical = canonicalUrl(location.href);
// Local drafts belong to this origin, so the app stays here until every one has synced.
async function leaveForCanonical() {
  const rows = await dbAction('readonly', (store) => store.getAll()).catch(() => []);
  if (rows.some(unsynced)) return false;
  // A Home Screen app keeps the origin it was added from; iOS opens the canonical one in a sheet.
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone)
    say(
      'This Home Screen icon opens a wrong address, where Google sign-in and walkthroughs fail. Delete the icon, then open ' +
        new URL(canonical).host +
        ' in Safari and add it to the Home Screen again.',
      'error',
    );
  location.replace(canonical);
  return true;
}
async function initialize() {
  if (canonical) {
    if (await leaveForCanonical()) return;
    $('hostSyncNotice').hidden = false;
  }
  initSignature();
  initFocusVisibility();
  renderControls();
  document
    .querySelectorAll('[data-task]')
    .forEach((tab) => tab.addEventListener('click', () => showTask(tab.dataset.task)));
  document.addEventListener('click', (event) => {
    document.querySelectorAll('.menu[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });
  const click = (id, fn) =>
    $(id).addEventListener('click', () =>
      Promise.resolve(fn()).catch((e) => say(e.message, 'error')),
    );
  const authClick = (id, fn) =>
    $(id).addEventListener('click', async () => {
      const controls = $('authPanel').querySelectorAll('button');
      authSay('');
      controls.forEach((control) => (control.disabled = true));
      try {
        await fn();
      } catch (e) {
        authSay(authMessage(e), 'error');
      } finally {
        controls.forEach((control) => (control.disabled = false));
      }
    });
  // Forgot password sits just above Google sign-in, so a stray tap must not send a reset email.
  const confirmReset = (email) =>
    new Promise((resolve) => {
      const dialog = $('resetDialog');
      $('resetDescription').textContent = 'Send a password reset link to ' + email + '?';
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'send'), {
        once: true,
      });
      dialog.showModal();
    });
  const credentials = () =>
    $('emailAuthForm').reportValidity()
      ? { email: $('authEmail').value.trim(), password: $('authPassword').value }
      : null;
  authClick('googleSignIn', async () => {
    const provider = new authSdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await authSdk.signInWithPopup(auth, provider);
  });
  $('emailAuthForm').addEventListener('submit', (e) => e.preventDefault());
  authClick('emailSignIn', async () => {
    const entered = credentials();
    if (entered) await authSdk.signInWithEmailAndPassword(auth, entered.email, entered.password);
  });
  authClick('emailReset', async () => {
    if (!$('authEmail').reportValidity()) return;
    const email = $('authEmail').value.trim();
    if (!(await confirmReset(email))) return;
    try {
      await authSdk.sendPasswordResetEmail(auth, email);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
    authSay('If an account uses ' + email + ', a password reset email is on its way.', 'success');
  });
  authClick('resendVerification', async () => {
    await authSdk.sendEmailVerification(auth.currentUser);
    authSay('Verification email sent to ' + auth.currentUser.email + '.', 'success');
  });
  authClick('confirmVerified', async () => {
    const user = auth.currentUser;
    await user.reload();
    await user.getIdToken(true);
    if (authStage(auth.currentUser) === 'unverified') {
      authSay(
        'This email is not verified yet. Open the link in the verification email, then try again.',
        'error',
      );
      return;
    }
    await applyUser(auth.currentUser);
  });
  const discardAndSignOut = async () => {
    state.queuePaused = true;
    await stopWalk();
    clearTimeout(state.queueRetry);
    clearTimeout(saveTimer);
    await authSdk.signOut(auth);
    // pagehide must not recreate the draft after local storage is cleared.
    state.user = null;
    state.session = null;
    state.draft = null;
    state.record = null;
    state.signed = null;
    invalidate();
    await clearLocal();
    location.reload();
  };
  const signOut = async () => {
    const paused = state.queuePaused;
    state.queuePaused = true;
    await stopWalk();
    clearTimeout(state.queueRetry);
    clearTimeout(saveTimer);
    await syncDraft().catch(() => {});
    await persist();
    const pending = (await localDrafts()).filter(unsynced).length;
    if (pending) {
      state.queuePaused = paused;
      $('unsyncedCount').textContent =
        pending +
        (pending === 1
          ? ' draft has not synced. Connect to the internet and wait for sync, or discard it and sign out.'
          : ' drafts have not synced. Connect to the internet and wait for sync, or discard them and sign out.');
      $('unsyncedActions').hidden = false;
      return;
    }
    await discardAndSignOut();
  };
  click('signOutButton', signOut);
  click('verifySignOut', signOut);
  click('discardSignOut', discardAndSignOut);
  click('newInspection', () => openNew());
  click('openJobs', () => (window.WorkspaceUI?.enabled() ? WorkspaceUI.jobs() : showJobs()));
  click('closeJobs', () => $('jobsDialog').close());
  click('helpButton', openHelp);
  click('closeHelp', () => $('helpDialog').close());
  $('helpDialog').addEventListener('close', () => $('helpButton').focus());
  click('cancelRoomRemoval', () => $('removeRoomDialog').close());
  click('confirmRoomRemoval', confirmRoomRemoval);
  $('removeRoomDialog').addEventListener('close', closeRoomRemoval);
  $('removeRoomDialog').addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const first = $('cancelRoomRemoval'),
      last = $('confirmRoomRemoval');
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  click('addRoom', () => {
    if (state.draft.data.rooms.length >= 30) throw Error('At most 30 rooms are supported.');
    state.draft.data.rooms.push({
      name: 'Room ' + (state.draft.data.rooms.length + 1),
      category: 1,
      unfinished_sf: 0,
      finished_sf: 0,
      custom_cabinetry: false,
      waste_percent: 0,
    });
    changed();
    renderRooms();
  });
  $('inspectionForm').addEventListener('submit', (e) => e.preventDefault());
  $('inspectionForm').addEventListener('input', (e) => {
    if (e.target === validationControl && e.target.validity.valid) clearValidationFeedback();
    if (e.target.dataset.roomKey) return;
    collect();
    changed(e.target.id !== 'scopeConfirmed');
  });
  $('technicianTranscript').addEventListener('input', () => {
    collect();
    if (state.draft?.data.capture_metadata)
      state.draft.data.capture_metadata.technician_edited = true;
    changed();
  });
  click('saveDraft', async () => {
    if (!state.session || !state.draft) throw Error('Sign in and open a draft first.');
    collect();
    await syncDraft();
    if (state.conflict) throw Error('Choose a recovery action before cloud saving.');
    say(navigator.onLine ? 'Draft saved privately.' : 'Draft saved on this device.', 'success');
  });
  click('finishAudit', finishAudit);
  click('fillScope', fillScopeFromWalkthrough);
  click('fillScopeProperty', fillScopeFromWalkthrough);
  click('applyScopeSuggestions', applyScopeSuggestions);
  click('dismissScopeSuggestions', clearScopePreview);
  click('startWalk', startWalk);
  click('stopWalk', () => stopWalk());
  click('muteMic', mute);
  click('takePhoto', captureStill);
  click('uploadPhoto', () => $('photoFileInput').click());
  click('thermalToggle', () => {
    const on = $('cameraVideo').classList.toggle('thermal-emulation');
    $('thermalBadge').hidden = !on;
    $('thermalToggle').textContent = on ? 'End color emulation' : 'Color emulation';
  });
  $('photoFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file)
      try {
        await addPhoto(file);
      } catch (error) {
        say(error.message, 'error');
      }
  });
  $('documentsConfirmed').addEventListener('change', () => {
    if ($('documentsConfirmed').checked) clearSigningError('documentsConfirmedError');
  });
  click('clearSignature', clearSignature);
  click('authorizeJob', async () => {
    try {
      await authorize();
    } catch (e) {
      if (!e.saveNotConfirmed) $('authorizationStatus').textContent = e.message;
      focusAndReveal($('authorizeJob'), $('authorizationStatus'));
      throw e;
    }
  });
  click('sendHomeownerLink', sendHomeownerLink);
  click('copyHomeownerLink', copyHomeownerLink);
  click('shareHomeownerLink', shareHomeownerLink);
  click('revokeHomeownerLink', revokeHomeownerLink);
  click('copyJson', copyJson);
  click('downloadJson', downloadJson);
  click('printDocuments', () => {
    if (!state.documents) throw Error('Open documents first.');
    window.print();
  });
  click('retrySavedEvidence', () => restoreSigned(confirmedAuthorization));
  document
    .querySelectorAll('[data-tab]')
    .forEach((tab) => tab.addEventListener('click', () => selectDocument(tab.dataset.tab)));
  click('restoreRemote', async () => {
    const record = await jsonApi('/api/inspections/' + state.draft.inspection_id);
    state.draft = {
      inspection_id: record.inspection_id,
      data: record.data,
      photos: record.photos.map((p) => ({ ...p, uploaded: true })),
    };
    state.record = record;
    state.ack = stable(record.data);
    state.conflict = false;
    $('conflictActions').hidden = true;
    invalidate();
    fillForm();
    await persist();
    await loadPhotoUrls('/api/inspections/' + record.inspection_id + '/photos/');
  });
  click('forkLocal', async () => {
    await loadPhotoUrls('/api/inspections/' + state.draft.inspection_id + '/photos/');
    const data = structuredClone(state.draft.data),
      photos = state.draft.photos.map((p) => ({
        ...p,
        id: newId(),
        uploaded: false,
        ocr_status: 'pending',
        ocr: null,
        file: undefined,
      }));
    for (const p of photos) {
      if (!p.data_url)
        throw Error(
          'Some original photos are unavailable. Reconnect and retry; your local draft is preserved.',
        );
    }
    await openNew(data, photos);
  });
  window.addEventListener('online', connectivity);
  window.addEventListener('offline', connectivity);
  window.addEventListener('pagehide', () => {
    persist();
    stopWalk();
  });
  window.addEventListener('beforeunload', (e) => {
    if (
      state.draft &&
      !state.signed &&
      (state.conflict ||
        stable(state.draft.data) !== state.ack ||
        state.draft.photos.some((p) => !p.uploaded))
    ) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  click('applyUpdate', async () => {
    await persist();
    await syncDraft().catch(() => {});
    await stopWalk();
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  });
  if ('serviceWorker' in navigator)
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const prompt = (worker) => {
        waitingWorker = worker;
        $('updateBanner').hidden = false;
      };
      if (registration.waiting) prompt(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing,
          controller = navigator.serviceWorker.controller;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && controller && controller !== worker) prompt(worker);
        });
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (waitingWorker && !refreshing) {
          refreshing = true;
          location.reload();
        }
      });
      const checkUpdate = () => {
        if (!document.hidden && navigator.onLine) registration.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', checkUpdate);
      window.addEventListener('focus', checkUpdate);
      setInterval(checkUpdate, 300000);
    } catch {
      say(
        'Offline launch is unavailable in this browser. Online private drafts remain available.',
        'error',
      );
    }
  $('yearBuilt').max = new Date().getFullYear();
  const [config, { initializeApp }, sdk, appCheckSdk] = await Promise.all([
    fetch('/__/firebase/init.json', { cache: 'no-store' }).then((response) => response.json()),
    import(FIREBASE_SDK + 'firebase-app.js'),
    import(FIREBASE_SDK + 'firebase-auth.js'),
    loadAppCheck(),
  ]);
  if (config.projectId !== 'alert-disaster-field-2026') throw Error('Incorrect Firebase project.');
  const app = initializeApp({ ...config, authDomain: authDomainFor(config, location.host) });
  activateAppCheck(app, appCheckSdk);
  authSdk = sdk;
  // IndexedDB, or localStorage where IndexedDB is unavailable: the persistence the compat SDK's Persistence.LOCAL chose.
  auth = sdk.initializeAuth(app, {
    persistence: [sdk.indexedDBLocalPersistence, sdk.browserLocalPersistence],
    popupRedirectResolver: sdk.browserPopupRedirectResolver,
  });
  sdk.onAuthStateChanged(auth, applyUser);
}
async function applyUser(user) {
  // Auth callbacks overlap; only the newest one may write state after an await.
  const epoch = ++authEpoch,
    stale = () => epoch !== authEpoch;
  if (state.user && state.user.uid !== user?.uid) {
    state.queuePaused = true;
    await stopWalk();
    clearTimeout(state.queueRetry);
    await syncChain.catch(() => {});
    await persist();
    confirmedAuthorization = null;
    $('retrySavedEvidence').hidden = true;
    $('signedEvidenceStatus').textContent = '';
    state.draft = null;
    state.record = null;
    state.ack = null;
    state.signed = null;
    state.documents = null;
    state.ocr.clear();
    invalidate();
    for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
    state.photoUrls.clear();
    clearDisplayedInspection();
    if (!user) await clearLocal();
    if (stale()) return;
  }
  const stage = authStage(user);
  state.user = user;
  state.session = null;
  state.workspaceInitializing = true;
  document.body.classList.remove('dashboard-open', 'office-view');
  $('workspaceNav').hidden = true;
  $('workspaceDashboard').hidden = true;
  $('jobCoordination').hidden = true;
  $('dashboardContent').replaceChildren();
  $('signOutButton').hidden = !user;
  $('inspectionFields').disabled = true;
  $('accountStatus').textContent = user ? user.email : 'Sign in to start an inspection';
  $('authPanel').hidden = stage === 'ready';
  $('googleSignIn').hidden = stage !== 'signedOut';
  // Signed out or unverified: only the login page shows, never the inspection workspace.
  document.body.classList.toggle('login-page', stage !== 'ready');
  $('emailAuthForm').hidden = stage !== 'signedOut';
  $('verifyEmail').hidden = stage !== 'unverified';
  $('verifyAddress').textContent = user?.email || '';
  renderControls();
  // Unverified accounts stay on the verification step: no drafts, sessions or authenticated API calls.
  if (stage !== 'ready') {
    state.workspaceInitializing = false;
    showTask('property', false);
    return;
  }
  try {
    let local = (await localDrafts()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      session;
    if (stale()) return;
    if (navigator.onLine) {
      const token = await user.getIdToken();
      if (stale()) return;
      let response = await fetch('/api/session', {
        cache: 'no-store',
        headers: { ...(await appCheckHeaders()), Authorization: 'Bearer ' + token },
      });
      if (stale()) return;
      if (response.status === 403) {
        response = await fetch('/api/access', {
          cache: 'no-store',
          headers: { ...(await appCheckHeaders()), Authorization: 'Bearer ' + token },
        });
        if (stale()) return;
      }
      if (!response.ok)
        throw Error('Your account has not been approved, or the connection is unavailable.');
      session = await response.json();
      if (stale()) return;
    } else {
      session = local[0]?.session;
      if (!session) throw Error('Sign in online before using private offline draft recovery.');
    }
    if (session.uid !== state.user?.uid || session.project !== 'alert-disaster-field-2026')
      throw Error('Incorrect session configuration.');
    state.session = session;
    state.queuePaused = false;
    if (state.session.workspaces_enabled) {
      await WorkspaceUI.ready();
      if (stale()) return;
      if (!state.session.role) {
        state.queuePaused = true;
        await WorkspaceUI.home();
        return;
      }
      await WorkspaceUI.landing();
    } else if (local.length) await restoreDraft(local[0].draft.inspection_id);
    else await openNew();
    if (stale()) return;
    connectivity();
    drainQueue();
  } catch (e) {
    if (!stale()) say(e.message, 'error');
  } finally {
    if (!stale()) {
      state.workspaceInitializing = false;
      for (const control of $('workspaceNav').querySelectorAll('button')) control.disabled = false;
    }
  }
}
document.addEventListener('DOMContentLoaded', () =>
  initialize().catch((e) => say('App initialization failed: ' + e.message, 'error')),
);
