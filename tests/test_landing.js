// The landing page's script against a stand-in document and model context: WebMCP registrations,
// the facts they return, the request-access form's declarative annotation, and the hand-off rules.
const assert = require('node:assert/strict'),
  fs = require('node:fs');
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
        else if (selector.startsWith('[') && child.requestAccess) found.push(child);
        else if (!selector.startsWith('.') && !selector.startsWith('[') && child.tag === selector)
          found.push(child);
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
  el('a', 'Request access', [], { requestAccess: true }),
  el('section', '', [], { id: 'requestAccess' }),
  el('form', '', [], { id: 'requestAccessForm', action: '#' }),
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
  const registered = landing.registerTools(win, '');
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
  // No tool asks for anything but the optional FAQ question.
  assert.deepEqual(
    seen.map((tool) => Object.keys(tool.inputSchema.properties)),
    [[], ['question'], []],
  );
  assert.ok(!seen.some((tool) => 'required' in tool.inputSchema));
  // Without a model context nothing is registered and nothing throws.
  assert.deepEqual(
    landing.registerTools({ document: el('body'), navigator: {}, location: {} }, ''),
    [],
  );
  // The navigator fallback is honoured too.
  delete doc.modelContext;
  const viaNavigator = [];
  landing.registerTools(
    {
      document: doc,
      navigator: { modelContext: { registerTool: async (tool) => viaNavigator.push(tool.name) } },
      location: { origin },
    },
    '',
  );
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
  assert.deepEqual((await faq.execute({ question: 'does the AI set prices?' })).faq, [
    {
      title: 'Does the AI set the prices?',
      detail: 'No. Every price is computed on the server from the sheet.',
    },
  ]);
  assert.equal((await faq.execute({})).faq.length, 2);
  assert.equal((await faq.execute({ question: 'zzz' })).faq.length, 2);
  assert.deepEqual(await access.execute({}), {
    how: 'DryScope has no public sign-up. Log in is for staff.',
    login_url: origin + '/app',
    request_access_url: null,
    request_access_form: null,
  });
  const configured = landing.tools(doc, origin, 'mailto:access@example.invalid')[2];
  assert.equal((await configured.execute({})).request_access_url, 'mailto:access@example.invalid');
  assert.equal((await configured.execute({})).request_access_form, origin + '/#requestAccess');

  // The request-access links, section and form stay hidden until an address is configured.
  assert.equal(landing.REQUEST_ACCESS_URL, '');
  for (const [value, expected] of [
    ['', ''],
    ['mailto:access@example.invalid', 'mailto:access@example.invalid'],
    ['https://example.invalid/demo', 'https://example.invalid/demo'],
    ['javascript:alert(1)', ''],
    ['http://example.invalid/demo', ''],
  ])
    assert.equal(landing.contactUrl(value), expected, value);
  landing.requestAccess(doc, '');
  assert.ok(doc.getElementById('requestAccess').hidden);
  assert.ok(doc.querySelector('[data-request-access]').hidden);
  landing.requestAccess(doc, 'https://example.invalid/demo');
  assert.ok(!doc.getElementById('requestAccess').hidden);
  assert.ok(!doc.querySelector('[data-request-access]').hidden);
  assert.equal(doc.getElementById('requestAccessForm').action, 'https://example.invalid/demo');

  // The mail request carries every field; nothing is sent anywhere else.
  assert.equal(
    landing.mailtoUrl('mailto:access@example.invalid', {
      company: 'Synthetic Restoration',
      name: 'Sam',
      email: 'sam@example.invalid',
      message: '',
    }),
    'mailto:access@example.invalid?subject=DryScope%20access%20request%20%C2%B7%20Synthetic%20Restoration&body=company%3A%20Synthetic%20Restoration%0Aname%3A%20Sam%0Aemail%3A%20sam%40example.invalid%0Amessage%3A%20',
  );

  // The declarative annotation in the HTML: a named, described form that is never auto-submitted,
  // hidden by default, with no tool attributes on the app's or anyone's sign-in form.
  const html = fs.readFileSync('public/index.html', 'utf8');
  const form = html.match(/<form id="requestAccessForm"[^>]*>/)[0];
  assert.match(form, /\btoolname="request_access"/);
  assert.match(form, /\btooldescription="[^"]{40,}"/);
  assert.doesNotMatch(html, /toolautosubmit/);
  assert.match(html, /<section id="requestAccess"[^>]*\bhidden\b/);
  assert.equal((html.match(/\btoolname=/g) || []).length, 1);
  assert.equal((html.match(/toolparamdescription=/g) || []).length, 4);
  assert.doesNotMatch(fs.readFileSync('public/app.html', 'utf8'), /toolname|tooldescription/);
  assert.doesNotMatch(fs.readFileSync('public/sign.html', 'utf8'), /toolname|tooldescription/);
  // Every visible FAQ entry and feature is restated, unchanged, in the JSON-LD block.
  const jsonLd = JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
  const byType = Object.fromEntries(jsonLd['@graph'].map((node) => [node['@type'], node]));
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&middot;/g, '·');
  const items = (className) =>
    html.match(new RegExp('<ul class="' + className + '">([\\s\\S]*?)</ul>'))[1];
  const faqItems = [
    ...items('landing-faq').matchAll(/<h3>(.*?)<\/h3><\/summary><p>(.*?)<\/p>/g),
  ].map((m) => [decode(m[1]), decode(m[2])]);
  assert.deepEqual(
    byType.FAQPage.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
    faqItems,
  );
  assert.ok(faqItems.length >= 5);
  assert.deepEqual(
    byType.SoftwareApplication.featureList,
    [...items('landing-features').matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => decode(m[1])),
  );
  assert.equal(
    byType.SoftwareApplication.description,
    html.match(/<p class="landing-lede">(.*?)<\/p>/)[1],
  );
  assert.ok(
    !('aggregateRating' in byType.SoftwareApplication) && !('offers' in byType.SoftwareApplication),
  );
  assert.ok(!('review' in byType.SoftwareApplication));
  assert.equal(byType.Organization.name, 'DryScope');

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
  assert.equal(
    landing.canonicalHref('https://alert-disaster-field-2026.web.app./?from=link#top'),
    'https://alert-disaster-field-2026.web.app/?from=link#top',
  );
  assert.equal(landing.canonicalHref('https://alert-disaster-field-2026.web.app/'), null);
  assert.ok(!landing.sessionKeys(['firebase:host:x', 'drafts']));
  console.log(
    'PASS: landing WebMCP registrations, facts from page text, request-access gating, hand-off rules',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
