// The landing page's script against a stand-in document and model context: WebMCP registrations,
// the facts they return, and the hand-off rules.
const assert = require('node:assert/strict');
const landing = require('../public/landing.js');

// A minimal element tree: enough querySelector for the selectors landing.js uses.
const el = (tag, textContent = '', children = [], attributes = {}) => {
  const node = { tag, textContent, children, hidden: false, ...attributes };
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.querySelectorAll = (selector) => {
    const want = selector.replace(/^\.?([a-z-]+) > li$/, '$1').replace(/^\./, '');
    const found = [];
    const walk = (current) => {
      for (const child of current.children) {
        if (selector.endsWith('> li')) {
          if (current.className === want && child.tag === 'li') found.push(child);
        } else if (selector.startsWith('.') && child.className === want) found.push(child);
        else if (!selector.startsWith('.') && child.tag === selector) found.push(child);
        walk(child);
      }
    };
    walk(node);
    return found;
  };
  return node;
};
const card = (title, detail) => el('li', title + ' ' + detail, [el('h3', title), el('p', detail)]);
const list = (className, cards) => el('ul', '', cards, { className });
const doc = el('body', '', [
  el('p', 'For water mitigation & disaster restoration companies', [], {
    className: 'landing-eyebrow',
  }),
  el('h1', 'Water & mold loss estimates, signed on site.', [], { id: 'landingHeading' }),
  el('p', ' DryScope is a field estimator   for the technician. ', [], {
    className: 'landing-lede',
  }),
  el('p', 'DryScope has no public sign-up. Log in is for staff.', [], { id: 'accessNote' }),
  list('landing-steps', [
    card('Walk & Photo', 'Talk and photograph.'),
    card('Check Scope', 'Confirm.'),
  ]),
  list('landing-docs', [card('Proposal', 'Low–high estimate.')]),
  list('landing-features', [card('Live walkthrough', 'Voice and camera.')]),
  list('landing-faq', [
    card(
      'Does the AI set the prices?',
      'No. Every price is computed on the server from the sheet.',
    ),
    card('Which losses does it estimate?', 'Water and mold losses only.'),
  ]),
]);
doc.getElementById = (id) => {
  const found = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.id === id) found.push(child);
      walk(child);
    }
  };
  walk(doc);
  return found[0] || null;
};
const origin = 'https://example.invalid';

(async () => {
  // Registration through a stand-in model context, as Chrome's origin trial exposes it.
  const seen = [];
  const win = {
    document: Object.assign(doc, {
      modelContext: { registerTool: async (tool) => seen.push(tool) },
    }),
    navigator: {},
    location: { origin },
  };
  const registered = landing.registerTools(win);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    seen.map((tool) => tool.name),
    ['dryscope_overview', 'dryscope_faq', 'dryscope_access'],
  );
  assert.equal(registered.length, 3);
  for (const tool of seen) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(tool.description.length > 40);
    assert.deepEqual(tool.annotations, { readOnlyHint: true });
    assert.equal(tool.inputSchema.type, 'object');
    assert.doesNotMatch(tool.name + ' ' + tool.description, /password|sign-in form|credential/i);
  }
  // No tool takes any input.
  assert.deepEqual(
    seen.map((tool) => Object.keys(tool.inputSchema.properties)),
    [[], [], []],
  );
  assert.ok(!seen.some((tool) => 'required' in tool.inputSchema));
  // Without a model context nothing is registered and nothing throws.
  assert.deepEqual(
    landing.registerTools({ document: el('body'), navigator: {}, location: {} }),
    [],
  );
  // The navigator fallback is honoured too.
  delete doc.modelContext;
  const viaNavigator = [];
  landing.registerTools({
    document: doc,
    navigator: { modelContext: { registerTool: async (tool) => viaNavigator.push(tool.name) } },
    location: { origin },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(viaNavigator.length, 3);

  // Every fact a tool returns is the page's own text, whitespace folded.
  const [overview, faq, access] = seen;
  const facts = await overview.execute({});
  assert.equal(facts.product, 'DryScope');
  assert.equal(facts.url, origin + '/');
  assert.equal(facts.headline, 'Water & mold loss estimates, signed on site.');
  assert.equal(facts.summary, 'DryScope is a field estimator for the technician.');
  assert.deepEqual(facts.steps, [
    { title: 'Walk & Photo', detail: 'Talk and photograph.' },
    { title: 'Check Scope', detail: 'Confirm.' },
  ]);
  assert.deepEqual(facts.documents, [{ title: 'Proposal', detail: 'Low–high estimate.' }]);
  assert.deepEqual(facts.features, [{ title: 'Live walkthrough', detail: 'Voice and camera.' }]);
  assert.ok(!('access' in facts) && !('faq' in facts));
  assert.deepEqual((await faq.execute({})).faq, [
    {
      title: 'Does the AI set the prices?',
      detail: 'No. Every price is computed on the server from the sheet.',
    },
    { title: 'Which losses does it estimate?', detail: 'Water and mold losses only.' },
  ]);
  assert.deepEqual(await access.execute({}), {
    how: 'DryScope has no public sign-up. Log in is for staff.',
    login_url: origin + '/app',
  });

  // Hand-off rules: old app deep links and a persisted Firebase session go to /app; plain visits stay.
  assert.equal(landing.APP, '/app');
  for (const search of [
    '?invite=' + 'a'.repeat(32),
    '?v=ui-20261006-6',
    '?mode=resetPassword&oobCode=x',
  ])
    assert.ok(landing.hasAppParams(search), search);
  for (const search of ['', '?utm_source=search', '?ref=card'])
    assert.ok(!landing.hasAppParams(search), search);
  assert.ok(landing.sessionKeys(['other', 'firebase:authUser:AIza:[DEFAULT]']));
  assert.ok(!landing.sessionKeys(['firebase:host:x', 'drafts']));
  console.log('PASS: landing WebMCP registrations, facts from page text, hand-off rules');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
