/* The owner's estimate accuracy. The server does the arithmetic; a suggestion only ever changes the
   working copy, and the published table changes only when the owner publishes it. */
(function (root) {
  const CATEGORY_LABEL = {
    1: 'Hidden damage in category 1 rooms',
    2: 'Hidden damage in category 2 rooms',
    3: 'Hidden damage in category 3 or mold rooms',
  };
  function suggestionRows(stats) {
    const given = stats?.suggestions;
    if (!given) return [];
    const rows = [];
    const add = (path, label, kind, suggestion) => {
      if (suggestion && suggestion.value != null)
        rows.push({ path, label, kind, value: suggestion.value, jobs: suggestion.jobs });
    };
    for (const category of Object.keys(CATEGORY_LABEL))
      add(
        'assist.hidden_damage_percent.' + category,
        CATEGORY_LABEL[category],
        'percent',
        given.hidden_damage_percent?.[category],
      );
    add(
      'assist.extra_drying_days',
      'Extra drying days on the high end',
      'days',
      given.extra_drying_days,
    );
    add('range.first_percent', 'Range cushion', 'percent', given.first_percent);
    return rows;
  }
  const readPath = (object, path) =>
    path.split('.').reduce((at, key) => (at == null ? at : at[key]), object);
  const suggestedValue = (row, policy) => {
    const beyond = row.path === 'range.first_percent' ? policy.range?.beyond_percent : undefined;
    return Number(beyond) > Number(row.value) ? beyond : row.value;
  };
  function applySuggestion(policy, row) {
    const value = suggestedValue(row, policy);
    const keys = row.path.split('.');
    let at = policy;
    for (const key of keys.slice(0, -1)) at = at[key] ??= {};
    at[keys[keys.length - 1]] = value;
    return policy;
  }
  const shown = (kind, value) => {
    if (value == null || value === '') return 'not set';
    if (kind === 'percent') return value + '%';
    return Number(value) === 1 ? '1 day' : value + ' days';
  };
  const suggestionText = (row, policy) =>
    `Suggested: ${shown(row.kind, suggestedValue(row, policy))} (now ${shown(row.kind, readPath(policy, row.path))})`;
  const matches = (row, policy) =>
    Number(readPath(policy, row.path)) === Number(suggestedValue(row, policy));

  const allowed = () =>
    !!state.session?.workspaces_enabled &&
    !!state.session.ai_features?.includes('estimate_assist') &&
    WorkspaceUI.can('prices_manage');
  const route = (companyId) => '/api/companies/' + companyId + '/estimate-accuracy';

  function dashboard(target) {
    if (!allowed() || !state.session.company_id || !navigator.onLine) return;
    const card = node('section', undefined, 'dashboard-card estimate-accuracy');
    card.hidden = true;
    target.append(card);
    jsonApi(route(state.session.company_id))
      .then((stats) => {
        if (!card.isConnected) return;
        const actions = node('div', undefined, 'actions');
        actions.append(
          button('Open', () => window.Prices.open().catch((e) => say(e.message, 'error'))),
        );
        card.append(node('h2', 'Estimate accuracy'), node('p', stats.headline), actions);
        card.hidden = false;
      })
      .catch(() => card.remove());
  }

  function paintSuggestions(box, stats, policy, used) {
    box.replaceChildren();
    if (!policy) return;
    for (const row of suggestionRows(stats)) {
      const line = node('div', undefined, 'estimate-suggestion');
      line.dataset.path = row.path;
      line.append(node('strong', row.label), node('p', suggestionText(row, policy)));
      if (matches(row, policy))
        line.append(node('p', 'Your working copy already uses this.', 'status'));
      else
        line.append(
          button('Use suggestion', () => {
            applySuggestion(policy, row);
            used(row.path);
            paintSuggestions(box, stats, policy, used);
          }),
        );
      box.append(line);
    }
  }

  /* editor is the Prices page's open table, or null on a rate-book page. */
  async function section(target, companyId, editor, used) {
    if (!allowed()) return;
    const card = node('section', undefined, 'price-card estimate-accuracy');
    card.id = 'estimateAccuracy';
    card.append(node('h2', 'Estimate accuracy'));
    const anchor = document.getElementById('priceSettings');
    if (anchor) anchor.after(card);
    else target.append(card);
    let stats;
    try {
      stats = await jsonApi(route(companyId));
    } catch (e) {
      if (card.isConnected) card.append(node('p', e.message, 'notice'));
      return;
    }
    if (!card.isConnected) return;
    for (const sentence of stats.sentences) card.append(node('p', sentence));
    const box = node('div', undefined, 'estimate-suggestions');
    card.append(box);
    paintSuggestions(box, stats, editor?.policy, used);
  }

  root.EstimateAccuracy = {
    suggestionRows,
    suggestionText,
    applySuggestion,
    matches,
    dashboard,
    section,
  };
})(typeof window === 'undefined' ? globalThis : window);
