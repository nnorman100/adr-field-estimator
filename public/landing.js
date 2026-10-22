/* The public landing page: hands a signed-in device on to /app and offers read-only WebMCP tools
   built from the page's own text. The page renders and reads completely without this script. */
'use strict';
const DryScopeLanding = (() => {
  const APP = '/app';
  // Old app deep links opened at "/": invitations, the fresh-URL cache buster and Firebase email actions.
  const APP_PARAMS = ['invite', 'v', 'mode', 'oobCode'];
  const SESSION_KEY = 'firebase:authUser:';
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
  const facts = (doc, origin) => ({
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
    },
  });
  const tools = (doc, origin) => [
    {
      name: 'dryscope_overview',
      description:
        'What DryScope is, who it is for and how a job runs: the three steps, the four documents it produces and the field features, as shown on the public landing page.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const data = facts(doc, origin);
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
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => ({ faq: facts(doc, origin).faq }),
    },
    {
      name: 'dryscope_access',
      description:
        'How a company gets DryScope access (invitation only, no public sign-up) and where existing staff log in.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => facts(doc, origin).access,
    },
  ];
  // Progressive enhancement: the page is complete without an agent; tools appear only where supported.
  const modelContext = (win) =>
    (win.document && win.document.modelContext) || (win.navigator && win.navigator.modelContext);
  function registerTools(win) {
    const context = modelContext(win);
    if (!context || typeof context.registerTool !== 'function') return [];
    const registered = tools(win.document, win.location.origin);
    for (const tool of registered)
      Promise.resolve()
        .then(() => context.registerTool(tool))
        .catch(() => {});
    return registered;
  }
  async function handOff(win) {
    const target = APP + win.location.search + win.location.hash;
    // A trailing-dot host (web.app.) is a separate origin: the app moves it to the live host once
    // the drafts and voice notes kept on this origin have synced.
    if (win.location.hostname.endsWith('.') || hasAppParams(win.location.search))
      return (win.location.replace(target), true);
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
    handOff(win).catch(() => {});
    registerTools(win);
  }
  return {
    APP,
    APP_PARAMS,
    hasAppParams,
    sessionKeys,
    facts,
    tools,
    registerTools,
    start,
  };
})();
if (typeof module !== 'undefined') module.exports = DryScopeLanding;
else DryScopeLanding.start(window);
