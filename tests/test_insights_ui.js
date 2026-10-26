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
    jsonApi: (path) =>
      new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
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
      fs.readFileSync('public/app.js', 'utf8') + `
        Object.assign(state, initialState, {user: {uid: 'reader'}});
        jsonApi = request;
        node = makeNode;
        button = makeButton;
        leaveNotes = stopWalk = persist = syncDraft = loadPhotoUrls = async () => {};
        localDrafts = async () => [];
        deleteDraft = async () => {};
        fillForm = renderDocuments = renderPhotos = showTask = say = () => {};
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
    requests,
    target,
    text: () => target.children.find((child) => child.tag === 'p' && child.text !== 'AI summary').text,
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
    const restoring = transition === 'draft'
      ? h.restores.restoreDraft('job')
      : h.restores.restoreSigned('authorization');
    await h.flush();
    assert.equal(h.requests[1].path, transition === 'draft'
      ? '/api/inspections/job'
      : '/api/authorizations/authorization');
    h.requests[1].resolve(transition === 'draft'
      ? { inspection_id: 'job', revision: 2, data: { rooms: [], air_movers: 8 }, photos: [] }
      : { inspection_id: 'job', inspection: { rooms: [] }, photos: [], documents: {} });
    await restoring;
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].path, '/api/jobs/job/insight?facts_only=true');
    h.requests[2].resolve(facts(null, true));
    await h.flush();
    assert.equal(h.text(), 'Facts changed. Refresh the summary.');
    h.target.children.at(-1).click();
    h.requests[3].resolve(facts());
    await h.flush();
    const current = transition === 'draft'
      ? 'Draft scope. 8 air movers.'
      : 'Signed agreement. Current facts.';
    h.requests[4].resolve(facts(current));
    await h.flush();
    assert.equal(h.text(), current);
  });
}
