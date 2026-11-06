const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(withRestores = false) {
  const element = (tag, text = '') => ({
    tag,
    text,
    isConnected: true,
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute() {},
    close() {},
  });
  const target = element('section');
  const requests = [];
  const context = {
    state: {
      session: { uid: 'reader', workspaces_enabled: true, ai_features: ['job_summary'] },
      draft: { inspection_id: 'job' },
    },
    WorkspaceUI: { context: () => 'company', can: () => true },
    $: (id) => (id === 'jobInsight' ? target : null),
    node: element,
    button: (text, click) => Object.assign(element('button', text), { click }),
    navigator: { onLine: true },
    document: {
      addEventListener() {},
      getElementById: () => target,
    },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    jsonApi: (path) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
  };
  context.window = context;
  if (withRestores) {
    context.ADRCore = require('../public/core.js');
    context.location = { href: 'https://example.test/app' };
    context.URL = URL;
    context.request = context.jsonApi;
    context.makeNode = element;
    context.makeButton = context.button;
    context.initialState = context.state;
    vm.runInNewContext(
      fs.readFileSync('public/app.js', 'utf8') +
        `
        Object.assign(state, initialState, {user: {uid: 'reader'}});
        globalThis.mutationApi = jsonApi;
        jsonApi = request;
        node = makeNode;
        button = makeButton;
        leaveNotes = stopWalk = persist = syncDraft = loadPhotoUrls = async () => {};
        loadHomeownerLinkStatus = async () => {};
        localDrafts = async () => [];
        deleteDraft = async () => {};
        fillForm = renderDocuments = renderPhotos = showTask = say = () => {};
        renderControls = renderNotes = () => {};
        seedRoomLoss = processNotes = drainQueue = () => {};
        absorb = (record) => { state.record = record; };
        api = async () => { throw Error('Synthetic unavailable evidence'); };
        globalThis.restoreHooks = {restoreDraft, restoreSigned, state};
      `,
      context,
    );
    context.WorkspaceUI.editor = async () => {};
  }
  vm.runInNewContext(fs.readFileSync('public/insights.js', 'utf8'), context);
  return {
    ui: context.InsightUI,
    restores: context.restoreHooks,
    context,
    requests,
    target,
    text: () =>
      target.children.find((child) => child.tag === 'p' && child.text !== 'AI summary').text,
    flush: async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}
const facts = (narrative = null, stale = false) => ({
  narrative,
  stale,
  facts: {},
  fact_lines: ['Current saved facts'],
});

for (const stage of ['facts', 'summary']) {
  test(`revision invalidation during ${stage} reloads facts after settlement`, async () => {
    const h = harness();
    h.ui.job();
    if (stage === 'summary') {
      h.requests[0].resolve(facts());
      await h.flush();
    }
    h.ui.job(true);
    h.ui.job(true);
    const active = h.requests.length - 1;
    h.requests[active].resolve(facts('Draft scope. Old revision.'));
    await h.flush();
    assert.equal(h.requests.length, active + 2);
    assert.equal(h.requests.at(-1).path, '/api/jobs/job/insight?facts_only=true');
    h.requests.at(-1).resolve(facts(null, true));
    await h.flush();
    assert.equal(h.text(), 'Facts changed. Refresh the summary.');
    assert.equal(h.target.children.at(-1).disabled, false);
    h.target.children.at(-1).click();
    h.requests.at(-1).resolve(facts());
    await h.flush();
    assert.equal(h.requests.at(-1).path, '/api/jobs/job/insight');
    h.requests.at(-1).resolve(facts('Draft scope. Current revision.'));
    await h.flush();
    assert.equal(h.text(), 'Draft scope. Current revision.');
  });
}

test('pending fact refresh preserves provider failure until a successful retry', async () => {
  const h = harness();
  h.ui.job();
  h.requests[0].resolve(facts());
  await h.flush();
  h.ui.job(true);
  h.requests[1].reject(Object.assign(Error('Provider unavailable'), { status: 502 }));
  await h.flush();
  assert.equal(h.requests[2].path, '/api/jobs/job/insight?facts_only=true');
  h.requests[2].resolve({ ...facts(), fact_lines: ['Updated saved facts'] });
  await h.flush();
  assert.equal(h.text(), 'Could not write the summary. Retry.');
  assert.equal(h.target.children.at(-2).children[1].children[0].text, 'Updated saved facts');
  const retry = h.target.children.at(-1);
  assert.equal(retry.text, 'Retry summary');
  assert.equal(retry.disabled, false);
  retry.click();
  h.requests[3].resolve(facts());
  await h.flush();
  assert.equal(h.requests[4].path, '/api/jobs/job/insight');
  h.requests[4].resolve(facts('Draft scope. Current facts.'));
  await h.flush();
  assert.equal(h.text(), 'Draft scope. Current facts.');
  assert.equal(h.target.children.at(-1).text, 'Refresh');
});

test('cancelled cards do not drain pending revision loads', async () => {
  const h = harness();
  h.ui.job();
  h.ui.job(true);
  h.ui.reset();
  h.requests[0].resolve(facts('Old private summary'));
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.target.children.length, 0);
});

for (const transition of ['draft', 'signed']) {
  test(`same-job ${transition} restore revalidates summary facts`, async () => {
    const h = harness(true);
    h.ui.job();
    h.requests[0].resolve(facts('Draft scope. Original facts.'));
    await h.flush();
    assert.equal(h.text(), 'Draft scope. Original facts.');
    const restoring =
      transition === 'draft'
        ? h.restores.restoreDraft('job')
        : h.restores.restoreSigned('authorization');
    await h.flush();
    assert.equal(
      h.requests[1].path,
      transition === 'draft' ? '/api/inspections/job' : '/api/authorizations/authorization',
    );
    h.requests[1].resolve(
      transition === 'draft'
        ? { inspection_id: 'job', revision: 2, data: { rooms: [], air_movers: 8 }, photos: [] }
        : { inspection_id: 'job', inspection: { rooms: [] }, photos: [], documents: {} },
    );
    await restoring;
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].path, '/api/jobs/job/insight?facts_only=true');
    h.requests[2].resolve(facts(null, true));
    await h.flush();
    assert.equal(h.text(), 'Facts changed. Refresh the summary.');
    h.target.children.at(-1).click();
    h.requests[3].resolve(facts());
    await h.flush();
    const current =
      transition === 'draft' ? 'Draft scope. 8 air movers.' : 'Signed agreement. Current facts.';
    h.requests[4].resolve(facts(current));
    await h.flush();
    assert.equal(h.text(), current);
  });
}

const factMutations = [
  ['audit completion', '/api/audit', 'POST', { inspection_id: 'job' }],
  ['claim save', '/api/jobs/job/claim', 'PUT', {}],
  ['reading add', '/api/inspections/job/readings', 'POST', {}],
  ['reading remove', '/api/inspections/job/readings/reading', 'DELETE'],
  ['monitoring change', '/api/jobs/job/drying-watch/state', 'POST', {}],
  ['delivery resend', '/api/jobs/job/delivery/resend', 'POST'],
  ['delivery reload', '/api/jobs/job/delivery', 'GET'],
  ['coordination save', '/api/jobs/job/coordination', 'PUT', {}],
  ['scope save', '/api/inspections/job', 'PUT', {}],
  ['photo upload', '/api/inspections/job/photos', 'POST', {}],
  ['photo OCR', '/api/inspections/job/photos/photo/ocr', 'POST'],
];
for (const [name, path, method, body] of factMutations) {
  test(`${name} revalidates facts independently of inspection revision`, async () => {
    const h = harness(true);
    h.restores.state.record = { revision: 1 };
    h.ui.job();
    h.requests[0].resolve(facts('Draft scope. Previous saved facts.'));
    await h.flush();
    const saved = { revision: 1, saved: true };
    h.context.api = async () => ({ json: async () => saved });
    assert.equal(await h.context.mutationApi(path, method, body), saved);
    assert.equal(h.restores.state.record.revision, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].path, '/api/jobs/job/insight?facts_only=true');
    h.requests[1].resolve(facts(null, true));
    await h.flush();
    assert.equal(h.text(), 'Facts changed. Refresh the summary.');
  });
}

test('mutation completion during a summary load drains through the pending refresh', async () => {
  const h = harness(true);
  h.ui.job();
  h.requests[0].resolve(facts());
  await h.flush();
  h.context.api = async () => ({ json: async () => ({ saved: true }) });
  await h.context.mutationApi('/api/jobs/job/claim', 'PUT', {});
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(facts('Draft scope. Old claim.'));
  await h.flush();
  assert.equal(h.requests[2].path, '/api/jobs/job/insight?facts_only=true');
  h.requests[2].resolve(facts(null, true));
  await h.flush();
  assert.equal(h.text(), 'Facts changed. Refresh the summary.');
});

for (const scenario of ['failed', 'other job', 'switched job', 'switched account', 'read only']) {
  test(`${scenario} request does not invalidate the current summary`, async () => {
    const h = harness(true);
    h.ui.job();
    h.requests[0].resolve(facts('Draft scope. Current facts.'));
    await h.flush();
    h.context.api = async () => {
      if (scenario === 'failed') throw Object.assign(Error('Rejected'), { status: 403 });
      if (scenario === 'switched job') h.restores.state.draft.inspection_id = 'new-job';
      if (scenario === 'switched account') h.restores.state.user = { uid: 'other' };
      return { json: async () => ({ saved: true }) };
    };
    const result = h.context.mutationApi(
      scenario === 'other job' ? '/api/jobs/other/claim' : '/api/jobs/job/claim',
      scenario === 'read only' ? 'GET' : 'PUT',
      {},
    );
    if (scenario === 'failed') await assert.rejects(result);
    else await result;
    assert.equal(h.requests.length, 1);
    assert.equal(h.text(), 'Draft scope. Current facts.');
  });
}

for (const blocked of ['offline', 'cooldown']) {
  test(`fact invalidation preserves the ${blocked} request guard`, async () => {
    const h = harness(true);
    h.context.setTimeout = () => 0;
    h.ui.job();
    if (blocked === 'cooldown') {
      h.requests[0].reject(Object.assign(Error('Limit reached'), { status: 429, retryAfter: 60 }));
    } else {
      h.requests[0].resolve(facts('Draft scope. Last loaded facts.'));
    }
    await h.flush();
    if (blocked === 'offline') h.context.navigator.onLine = false;
    h.context.api = async () => ({ json: async () => ({ saved: true }) });
    await h.context.mutationApi('/api/jobs/job/claim', 'PUT', {});
    assert.equal(h.requests.length, 1);
    assert.equal(h.target.children.at(-1).disabled, true);
  });
}

test('owner spending loads without the optional AI counts feature', async () => {
  const h = harness();
  h.context.state.session.role = 'owner';
  h.context.state.session.company_id = 'adr';
  h.context.state.session.ai_features = [];
  h.ui.spending(h.target);
  assert.equal(h.requests[0].path, '/api/session');
  h.requests[0].resolve({
    ai_spending: {
      month: '2026-11',
      spent_microusd: 2000000,
      reserved_microusd: 2000000,
      monthly_cap_microusd: 10000000,
      live_margin_microusd: 2000000,
    },
  });
  await h.flush();
  const card = h.target.children[0];
  assert.ok(card.children.some((c) => c.text === '$4.00 of $10.00 · 2026-11 (UTC)'));
  const progress = card.children.find((c) => c.tag === 'progress');
  assert.equal(progress.max, 10000000);
  assert.equal(progress.value, 4000000);
  assert.ok(card.children.some((c) => c.text?.includes('soft limit')));
});

test('spending is owner-only and does not reuse another company response', async () => {
  const h = harness();
  h.context.state.session.role = 'office';
  h.ui.spending(h.target);
  assert.equal(h.requests.length, 0);
  assert.equal(h.target.children.length, 0);
  h.context.state.session.role = 'owner';
  h.context.state.session.company_id = 'adr';
  h.ui.spending(h.target);
  h.context.state.session.uid = 'another-owner';
  h.requests[0].resolve({ spent_microusd: 2000000 });
  await h.flush();
  assert.equal(h.target.children[0].children[1].text, 'Loading spending…');
});

test('offline spending makes no request and offers a disabled refresh', async () => {
  const h = harness();
  h.context.state.session.role = 'owner';
  h.context.navigator.onLine = false;
  h.ui.spending(h.target);
  assert.equal(h.requests.length, 0);
  const card = h.target.children[0];
  assert.ok(card.children.some((c) => c.text?.includes('Offline')));
  assert.equal(card.children.find((c) => c.tag === 'button').disabled, true);
});
