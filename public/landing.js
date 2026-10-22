/* The public landing page: hands a signed-in device on to /app, shows the request-access form once an
   address is configured, and offers read-only WebMCP tools built from the page's own text. The page
   renders and reads completely without this script. */
'use strict';
const DryScopeLanding = (() => {
  // Where "Request access" sends people: a mailto: address or an https: page. Public
  // sign-up stays off, so this never creates an account. Empty hides the links and the form.
  const REQUEST_ACCESS_URL = '';
  const APP = '/app';
  // Old app deep links opened at "/": invitations, the fresh-URL cache buster and Firebase email actions.
  const APP_PARAMS = ['invite', 'v', 'mode', 'oobCode'];
  const SESSION_KEY = 'firebase:authUser:';
  const contactUrl = (value) => (/^(mailto:|https:\/\/)/.test(value || '') ? value : '');
  const hasAppParams = (search) => {
    const params = new URLSearchParams(search || '');
    return APP_PARAMS.some((name) => params.has(name));
  };
  const sessionKeys = (keys) => keys.some((key) => String(key).startsWith(SESSION_KEY));
  // The Firebase SDK persists a signed-in user under firebase:authUser:* in IndexedDB, or in
  // localStorage where IndexedDB is unavailable. Reading the key is enough; the app checks the session.
  const sessionInLocalStorage = (storage) => {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
      return sessionKeys(keys);
    } catch {
      return false;
    }
  };
  const sessionInIndexedDb = (indexedDB) =>
    new Promise((resolve) => {
      if (!indexedDB) return resolve(false);
      let request;
      try {
        request = indexedDB.open('firebaseLocalStorageDb');
      } catch {
        return resolve(false);
      }
      // No database yet means no session; aborting the upgrade leaves none behind.
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = request.onblocked = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        try {
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
            db.close();
            return resolve(false);
          }
          const keys = db
            .transaction('firebaseLocalStorage')
            .objectStore('firebaseLocalStorage')
            .getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve(sessionKeys(keys.result || []));
          };
          keys.onerror = () => {
            db.close();
            resolve(false);
          };
        } catch {
          db.close();
          resolve(false);
        }
      };
    });
  const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
  const cards = (doc, selector) =>
    Array.from(doc.querySelectorAll(selector), (card) => ({
      title: text(card.querySelector('h3')),
      detail: text(card.querySelector('p')),
    }));
  // One source of truth: every fact a tool returns is the visible text of the page.
  const facts = (doc, origin, contact) => ({
    product: 'DryScope',
    url: origin + '/',
    login_url: origin + APP,
    audience: text(doc.querySelector('.landing-eyebrow')),
    headline: text(doc.getElementById('landingHeading')),
    summary: text(doc.querySelector('.landing-lede')),
    steps: cards(doc, '.landing-steps > li'),
    documents: cards(doc, '.landing-docs > li'),
    features: cards(doc, '.landing-features > li'),
    faq: cards(doc, '.landing-faq > li'),
    access: {
      how: text(doc.getElementById('accessNote')),
      login_url: origin + APP,
      request_access_url: contact || null,
      request_access_form: contact ? origin + '/#requestAccess' : null,
    },
  });
  // Keyword match for the FAQ tool; function words never decide a match.
  const STOP = new Set(
    'the and for with how what which who does doe did can you your our this that from into only are was were has have had not but its'.split(
      ' ',
    ),
  );
  const words = (value) =>
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP.has(word));
  const tools = (doc, origin, contact) => [
    {
      name: 'dryscope_overview',
      description:
        'What DryScope is, who it is for and how a job runs: the three steps, the four documents it produces and the field features, as shown on the public landing page.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const data = facts(doc, origin, contact);
        return {
          product: data.product,
          url: data.url,
          audience: data.audience,
          headline: data.headline,
          summary: data.summary,
          steps: data.steps,
          documents: data.documents,
          features: data.features,
        };
      },
    },
    {
      name: 'dryscope_faq',
      description:
        "Answers from the landing page's FAQ: what DryScope is, who it is for, invitation-only access, the documents it produces, that the AI never sets prices, which losses it covers and how it works without signal.",
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'Optional question or keywords. Leave it out to get every question and answer.',
          },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const faq = facts(doc, origin, contact).faq;
        const terms = words(input && input.question);
        if (!terms.length) return { faq };
        const matches = faq
          .map((entry) => ({
            entry,
            score: terms.filter((term) => words(entry.title + ' ' + entry.detail).includes(term))
              .length,
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((item) => item.entry);
        return { faq: matches.length ? matches : faq };
      },
    },
    {
      name: 'dryscope_access',
      description:
        'How a company gets DryScope access (invitation only, no public sign-up), where existing staff log in, and where to request access when a contact address is configured.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => facts(doc, origin, contact).access,
    },
  ];
  // Progressive enhancement: the page is complete without an agent; tools appear only where supported.
  const modelContext = (win) =>
    (win.document && win.document.modelContext) || (win.navigator && win.navigator.modelContext);
  function registerTools(win, contact) {
    const context = modelContext(win);
    if (!context || typeof context.registerTool !== 'function') return [];
    const registered = tools(win.document, win.location.origin, contact);
    for (const tool of registered)
      Promise.resolve()
        .then(() => context.registerTool(tool))
        .catch(() => {});
    return registered;
  }
  function requestAccess(doc, contact) {
    for (const link of doc.querySelectorAll('[data-request-access]')) link.hidden = !contact;
    const section = doc.getElementById('requestAccess'),
      form = doc.getElementById('requestAccessForm');
    if (section) section.hidden = !contact;
    if (!form || !contact) return;
    if (contact.startsWith('https://')) {
      // A GET to the configured page, carrying the fields as query parameters.
      form.action = contact;
      return;
    }
    // A mailto: address: the person's mail app opens with the request filled in.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      doc.defaultView.location.href = mailtoUrl(
        contact,
        Object.fromEntries(['company', 'name', 'email', 'message'].map((f) => [f, data.get(f)])),
      );
    });
  }
  function mailtoUrl(contact, fields) {
    const company = fields.company || '';
    const subject = 'DryScope access request' + (company ? ' · ' + company : '');
    const body = ['company', 'name', 'email', 'message']
      .map((field) => field + ': ' + (fields[field] || ''))
      .join('\n');
    return (
      contact +
      (contact.includes('?') ? '&' : '?') +
      'subject=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(body)
    );
  }
  // A host with a trailing dot (web.app.) is a separate origin the app refuses; the live host's URL.
  const canonicalHref = (href) => {
    const url = new URL(href);
    if (!url.hostname.endsWith('.')) return null;
    url.hostname = url.hostname.replace(/\.+$/, '');
    return url.href;
  };
  async function handOff(win) {
    const canonical = canonicalHref(win.location.href);
    if (canonical) return (win.location.replace(canonical), true);
    const target = APP + win.location.search + win.location.hash;
    if (hasAppParams(win.location.search)) return (win.location.replace(target), true);
    let storage = null;
    try {
      storage = win.localStorage;
    } catch {
      storage = null;
    }
    if (storage && sessionInLocalStorage(storage)) return (win.location.replace(target), true);
    if (await sessionInIndexedDb(win.indexedDB)) return (win.location.replace(target), true);
    return false;
  }
  function start(win) {
    const contact = contactUrl(REQUEST_ACCESS_URL);
    handOff(win).catch(() => {});
    requestAccess(win.document, contact);
    registerTools(win, contact);
  }
  return {
    APP,
    APP_PARAMS,
    REQUEST_ACCESS_URL,
    contactUrl,
    hasAppParams,
    sessionKeys,
    canonicalHref,
    facts,
    tools,
    registerTools,
    requestAccess,
    mailtoUrl,
    start,
  };
})();
if (typeof module !== 'undefined') module.exports = DryScopeLanding;
else DryScopeLanding.start(window);
