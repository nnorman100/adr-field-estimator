/* Read-only, session-memory summaries. Never enqueue AI requests or persist their text. */
window.InsightUI = (() => {
  const cache = new Map();
  const cards = new Set();
  let actor = '',
    jobCard = null;
  const enabled = (feature) =>
    !!state.session?.workspaces_enabled && state.session.ai_features?.includes(feature);
  const identity = () => [state.session?.uid, WorkspaceUI.context()].join('|');
  const names = {
    ocr: 'Photo readings',
    audit: 'Audits',
    scope: 'Scope fills',
    live: 'Live sessions',
    transcribe: 'Voice notes',
    drying_summary: 'Drying summaries',
    job_summary: 'Job summaries',
  };
  function reset() {
    actor = identity();
    cache.clear();
    for (const card of cards) card.cancel();
    cards.clear();
    jobCard = null;
    $('aiQuota')?.replaceChildren();
    if ($('aiQuota')) $('aiQuota').hidden = true;
    $('jobInsight')?.replaceChildren();
    if ($('jobInsight')) $('jobInsight').hidden = true;
  }
  function check() {
    if (actor !== identity()) reset();
  }
  function mount(target, job, company = null) {
    check();
    const requested = identity(),
      key = [requested, company || '', job].join('|');
    let value = cache.get(key),
      busy = false,
      pending = false,
      error = '',
      until = 0,
      timer,
      epoch = 0;
    const path = company
      ? `/api/admin/companies/${company}/jobs/${job}/insight`
      : `/api/jobs/${job}/insight`;
    const valid = (generation) =>
      generation === epoch && requested === identity() && target.isConnected;
    function render() {
      if (requested !== identity()) return;
      target.replaceChildren(node('h2', 'At a glance'), node('p', 'AI summary', 'eyebrow'));
      target.setAttribute('aria-busy', String(busy));
      if (!navigator.onLine)
        target.append(
          node(
            'p',
            value ? 'Offline · last loaded summary and facts.' : 'Connect to load the summary.',
            'notice',
          ),
        );
      const text =
        value?.narrative ||
        error ||
        (busy
          ? 'Writing summary…'
          : company
            ? 'No current saved summary. Support is read only.'
            : value?.stale
              ? 'Facts changed. Refresh the summary.'
              : 'Summary not loaded.');
      target.append(node('p', text, 'insight-narrative'));
      if (error && value?.narrative) target.append(node('p', error, 'notice'));
      if (value) {
        const facts = node('details'),
          list = node('ul');
        facts.append(node('summary', 'Saved job facts'));
        for (const line of [value.facts.customer, value.facts.address, ...value.fact_lines].filter(
          Boolean,
        ))
          list.append(node('li', line));
        facts.append(list);
        target.append(facts);
      }
      const refresh = button(error ? 'Retry summary' : 'Refresh', () => load(false));
      refresh.disabled = busy || !navigator.onLine || Date.now() < until;
      target.append(refresh);
    }
    async function load(factsOnly = false) {
      if (busy && factsOnly) pending = true;
      if (busy || !navigator.onLine || Date.now() < until) {
        render();
        return;
      }
      const generation = ++epoch;
      busy = true;
      if (!factsOnly) error = '';
      render();
      try {
        const facts = await jsonApi(path + (company ? '' : '?facts_only=true'));
        if (!valid(generation)) return;
        value = facts;
        cache.set(key, value);
        render();
        if (!company && !factsOnly && !value.narrative) {
          const result = await jsonApi(path);
          if (!valid(generation)) return;
          value = result;
          cache.set(key, value);
        }
      } catch (e) {
        if (!valid(generation)) return;
        if ([403, 404].includes(e.status)) {
          value = null;
          cache.delete(key);
        }
        error = 'Could not write the summary. Retry.';
        if (e.status === 429) {
          const seconds = Math.max(1, e.retryAfter || 1);
          until = Date.now() + seconds * 1000;
          error += ` Limit reached. Retry after ${seconds} seconds.`;
          clearTimeout(timer);
          timer = setTimeout(render, seconds * 1000);
        } else if (e.status === 409) error = 'Facts changed. Refresh the summary.';
      } finally {
        if (valid(generation)) {
          busy = false;
          render();
          if (pending) {
            pending = false;
            load(true);
          }
        }
      }
    }
    const controller = {
      job,
      target,
      render,
      load,
      cancel() {
        ++epoch;
        clearTimeout(timer);
        cards.delete(controller);
      },
    };
    cards.add(controller);
    render();
    load();
    return controller;
  }
  function job(changed = false) {
    check();
    const target = $('jobInsight'),
      id = state.draft?.inspection_id;
    if (!target) return;
    target.hidden = !enabled('job_summary') || !id || !WorkspaceUI.can('jobs_read');
    if (target.hidden) return;
    if (!jobCard || jobCard.job !== id) {
      jobCard?.cancel();
      jobCard = mount(target, id);
    } else if (changed) jobCard.load(true);
    else jobCard.render();
  }
  function row(target, id, company = null) {
    if (!enabled('job_summary')) return;
    const details = node('details', undefined, 'insight-expander'),
      body = node('section', undefined, 'insight-card');
    details.append(node('summary', 'At a glance'), body);
    target.append(details);
    let mounted = false;
    details.addEventListener('toggle', () => {
      if (details.open && !mounted) {
        mounted = true;
        mount(body, id, company);
      }
    });
  }
  function support(target, id, company) {
    if (!enabled('job_summary')) return;
    const card = node('section', undefined, 'dashboard-card insight-card');
    target.append(card);
    mount(card, id, company);
  }
  function account() {
    check();
    const target = $('aiQuota');
    if (!target) return;
    target.hidden = !enabled('ai_usage');
    if (target.hidden) return;
    const quota = state.session?.quota;
    target.textContent = quota
      ? 'AI calls left today: ' +
        Object.entries(quota)
          .map(
            ([operation, counts]) =>
              `${names[operation] || operation} ${counts.remaining} of ${counts.limit}`,
          )
          .join(' · ')
      : 'Usage unavailable';
  }
  async function refreshAccount() {
    if (!enabled('ai_usage') || !navigator.onLine) {
      account();
      return;
    }
    const requested = identity();
    try {
      const session = await jsonApi('/api/session');
      if (requested === identity()) state.session.quota = session.quota;
    } catch {
      if (requested === identity()) state.session.quota = null;
    }
    account();
  }
  function usage(target, company = null) {
    if (!enabled('ai_usage') || (!company && state.session.role !== 'owner')) return;
    const requested = identity(),
      card = node('section', undefined, 'dashboard-card ai-usage');
    target.append(card);
    async function load() {
      card.replaceChildren(
        node('h2', 'AI usage today'),
        node('p', navigator.onLine ? 'Loading usage…' : 'Usage unavailable · connect to load.'),
      );
      if (!navigator.onLine) {
        const retry = button('Refresh usage', load);
        retry.disabled = true;
        card.append(retry);
        return;
      }
      try {
        const result = await jsonApi(
          company
            ? `/api/admin/companies/${company}/ai-usage`
            : `/api/companies/${state.session.company_id}/ai-usage`,
        );
        if (requested !== identity() || !card.isConnected) return;
        card.replaceChildren(node('h2', 'AI usage today'));
        card.append(
          node(
            'p',
            `${result.members} active members. Counts use each person’s current 24-hour window, beginning with their first call. Failed requests also use slots; cached summaries do not.`,
          ),
        );
        for (const [operation, counts] of Object.entries(result.operations)) {
          const label = node(
              'label',
              `${names[operation] || operation}: ${counts.used} of ${counts.limit} · ${counts.per_user_limit} per person`,
            ),
            bar = node('progress');
          bar.max = Math.max(1, counts.limit);
          bar.value = counts.used;
          label.append(bar);
          card.append(label);
        }
      } catch {
        if (requested === identity() && card.isConnected)
          card.replaceChildren(node('h2', 'AI usage today'), node('p', 'Usage unavailable'));
      }
      if (card.isConnected) {
        const offline = node('p', 'Offline · last loaded counts.', 'usage-offline notice');
        offline.hidden = navigator.onLine;
        const retry = button('Refresh usage', load);
        retry.disabled = !navigator.onLine;
        card.append(offline, retry);
      }
    }
    load();
  }
  function spending(target) {
    if (state.session.role !== 'owner') return;
    const requested = identity(),
      card = node('section', undefined, 'dashboard-card ai-spending'),
      show = (text) => card.replaceChildren(node('p', 'AI used this month: ' + text));
    target.append(card);
    if (!navigator.onLine) return show('connect to load.');
    show('loading…');
    const money = (micro) => '$' + (micro / 1000000).toFixed(2);
    jsonApi(`/api/companies/${state.session.company_id}/ai-spending`).then(
      (result) => {
        if (requested !== identity() || !card.isConnected) return;
        show(
          `${money(result.spent_microusd + result.reserved_microusd)} of ${money(result.monthly_cap_microusd)}`,
        );
      },
      () => {
        if (requested !== identity() || !card.isConnected) return;
        show('unavailable.');
      },
    );
  }
  function connectivity() {
    check();
    account();
    for (const control of document.querySelectorAll('.ai-usage button'))
      control.disabled = !navigator.onLine;
    for (const notice of document.querySelectorAll('.usage-offline'))
      notice.hidden = navigator.onLine;
    for (const card of cards) {
      if (!card.target.isConnected) {
        card.cancel();
        cards.delete(card);
      } else card.render();
    }
  }
  window.addEventListener('online', connectivity);
  window.addEventListener('offline', connectivity);
  document.addEventListener('DOMContentLoaded', () =>
    $('accountMenu')?.addEventListener('toggle', () => {
      if ($('accountMenu').open) refreshAccount();
    }),
  );
  return { reset, job, row, support, usage, spending, account, enabled };
})();
