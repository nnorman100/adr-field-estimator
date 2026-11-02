/* Company prices. Changes stay online and never enter the draft queue. */
(function (root) {
  const zeroKeys = ['emergency_call', 'after_hours_job_charge'];
  // No price is written here: amounts come from the API for the signed-in company.
  const AFTER_HOURS_DEFAULT =
    'After-hours loss: company after-hours job charge and 20% labor/material adjustment.';
  let shown = null,
    jobSeq = 0;

  function grouped(rows) {
    const order = [],
      groups = new Map();
    for (const row of rows || []) {
      if (!groups.has(row.group)) {
        groups.set(row.group, []);
        order.push(row.group);
      }
      groups.get(row.group).push(row);
    }
    return order.map((name) => ({ name, rows: groups.get(name) }));
  }
  function companyDisplay() {
    return typeof state === 'undefined' ? null : state?.session?.price_display || null;
  }
  function afterHoursSentence(rates, sheetRates) {
    const own = companyDisplay(),
      shown = rates || own,
      charge = shown?.after_hours_job_charge,
      labor = shown?.sheet_labor_hourly;
    if (!charge || !labor) return AFTER_HOURS_DEFAULT;
    const money = (value) => Number(value).toFixed(2);
    if (
      sheetRates ||
      (money(charge) === money(own?.after_hours_job_charge) &&
        money(labor) === money(own?.sheet_labor_hourly))
    )
      return (
        'After-hours loss: $' +
        money(charge).replace(/\.00$/, '') +
        " job charge and 20% labor/material adjustment. Added labor uses the sheet's $" +
        money(labor) +
        '/hr estimate formula.'
      );
    return (
      'After-hours loss: $' +
      money(charge) +
      " job charge and 20% labor/material adjustment. Added labor uses the job's $" +
      money(labor) +
      '/hr estimate formula.'
    );
  }
  function enabled() {
    return !!(state?.session?.price_books_enabled && state?.session?.workspaces_enabled);
  }
  function jobChargesTotal() {
    return shown && shown.inspectionId === state?.draft?.inspection_id
      ? shown.standardJobCharges
      : state?.session?.price_display?.standard_job_charges;
  }
  function dom() {
    return typeof document !== 'undefined' && typeof document.getElementById === 'function';
  }
  function syncNotice() {
    if (!dom() || !$('pricesNotSet')) return;
    const missing = state?.session?.prices_set === false;
    $('pricesNotSet').hidden = !missing;
    $('pricesNotSetActions').replaceChildren();
    if (!missing) return;
    $('pricesNotSetText').textContent = state.session.prices_not_set_message;
    if (state.session.role === 'owner' && enabled())
      $('pricesNotSetActions').append(
        button('Set company prices', () => open().catch((e) => say(e.message, 'error'))),
      );
  }
  function clearJob() {
    shown = null;
    if (!dom() || !$('jobPricing')) return;
    syncNotice();
    $('jobPricing').hidden = true;
    $('jobPricingStatus').textContent = '';
    $('jobPricingActions').replaceChildren();
    if ($('afterHoursLabel')) $('afterHoursLabel').textContent = afterHoursSentence();
    if (typeof renderJobChargesSummary === 'function') renderJobChargesSummary();
  }
  async function noteJob() {
    if (!dom() || !$('jobPricing')) return;
    const id = state?.draft?.inspection_id;
    const ready = enabled() && id && navigator.onLine && state.session && state.user;
    if (!ready) {
      clearJob();
      return;
    }
    const mine = ++jobSeq,
      uid = state.user.uid,
      company = state.session.company_id;
    try {
      const view = await jsonApi('/api/inspections/' + id + '/pricing');
      if (
        mine !== jobSeq ||
        state.user?.uid !== uid ||
        state.session?.company_id !== company ||
        state.draft?.inspection_id !== id
      )
        return;
      shown = { inspectionId: id, standardJobCharges: view.display_rates?.standard_job_charges };
      syncNotice();
      $('jobPricing').hidden = !view.pinned && state.session.prices_set === false;
      $('jobPricingStatus').textContent = view.pinned
        ? 'This job is priced from ' + view.pinned.label + '.'
        : view.pending_note || 'Rates are confirmed at the first online pricing.';
      if (view.newer_available)
        $('jobPricingStatus').textContent +=
          ' Newer company prices are available. This draft keeps its prices until an owner applies them.';
      $('jobPricingActions').replaceChildren();
      if (view.can_reprice)
        $('jobPricingActions').append(
          button('Review new prices for this job', () =>
            reviewReprice().catch((e) => say(e.message, 'error')),
          ),
        );
      if ($('afterHoursLabel'))
        $('afterHoursLabel').textContent = afterHoursSentence(view.display_rates, view.sheet_rates);
      if (typeof renderJobChargesSummary === 'function') renderJobChargesSummary();
    } catch (e) {
      if (mine !== jobSeq) return;
      $('jobPricing').hidden = false;
      $('jobPricingStatus').textContent = e.message;
      $('jobPricingActions').replaceChildren();
    }
  }
  async function reviewReprice() {
    const id = state.draft.inspection_id,
      preview = await jsonApi('/api/inspections/' + id + '/pricing/reprice-preview', 'POST'),
      actions = $('jobPricingActions');
    actions.replaceChildren();
    for (const row of preview.diff)
      actions.append(node('p', row.description + ': ' + row.before + ' to ' + row.after));
    actions.append(
      node(
        'p',
        'Itemized ' +
          preview.before.itemized +
          ' to ' +
          preview.after.itemized +
          '. Customer range ' +
          preview.before.low +
          '–' +
          preview.before.high +
          ' to ' +
          preview.after.low +
          '–' +
          preview.after.high +
          '.',
      ),
    );
    actions.append(
      node(
        'p',
        'This applies ' + preview.to_label + ' to this draft only. Other jobs keep their prices.',
      ),
    );
    actions.append(
      button('Apply these prices to this job only', async () => {
        const record = await jsonApi('/api/inspections/' + id + '/pricing/reprice', 'POST', {
          expected_revision: preview.revision,
          expected_pin_hash: preview.from_hash,
          destination_version_id: preview.to_version_id,
          destination_hash: preview.to_hash,
        });
        absorb(record);
        if (state.draft?.inspection_id === id && record.data) {
          state.draft.data.scope_confirmed = !!record.data.scope_confirmed;
          $('scopeConfirmed').checked = state.draft.data.scope_confirmed;
          $('scopeConfirmNotice').hidden = !state.draft.data.scope_confirmed;
          if (stable(state.draft.data) === stable(record.data)) state.ack = stable(record.data);
        }
        await persist();
        say('New prices apply to this draft. Confirm scope and finish review again.', 'success');
        noteJob();
      }),
    );
    actions.append(button('Keep saved prices', () => noteJob()));
  }
  function warningText(code) {
    if (code === 'large_change')
      return 'One or more prices changed by 50% or more. Check them before publishing.';
    if (code === 'zero_rate') return 'A zero charge is included. Confirm that it is intentional.';
    return code;
  }
  function reviewPanel(preview, onPublish) {
    const panel = node('section', undefined, 'price-card');
    panel.id = 'priceReview';
    if (preview.no_changes) {
      panel.append(node('p', 'No changes'));
      return panel;
    }
    panel.append(node('h2', 'Review changes'));
    for (const row of preview.diff)
      panel.append(
        node(
          'p',
          row.description +
            ' (' +
            row.unit +
            '): ' +
            (row.before || 'not set') +
            ' to ' +
            row.after,
        ),
      );
    for (const warning of preview.warnings || []) panel.append(node('p', warningText(warning)));
    const before = preview.sample_before,
      after = preview.sample_after;
    if (before)
      panel.append(
        node(
          'p',
          'Sample before: itemized ' +
            before.itemized +
            ', range ' +
            before.low +
            '–' +
            before.high +
            '. ' +
            before.label,
        ),
      );
    panel.append(
      node(
        'p',
        'Sample after: itemized ' +
          after.itemized +
          ', range ' +
          after.low +
          '–' +
          after.high +
          '.',
      ),
      node('p', preview.effect || ''),
    );
    if (onPublish) {
      const actions = node('form', undefined, 'price-actions');
      actions.append(button('Publish prices', onPublish));
      panel.append(actions);
    }
    return panel;
  }
  function collect(form) {
    const rates = {},
      acknowledgements = [];
    for (const input of form.querySelectorAll('input[data-price-key]')) {
      const key = input.dataset.priceKey;
      rates[key] = input.value.trim();
      if (!zeroKeys.includes(key) || Number(rates[key]) !== 0) continue;
      const box = form.elements['ack_' + key];
      if (!box?.checked) {
        box?.focus();
        throw Error('Confirm that a zero charge is intentional before reviewing it.');
      }
      acknowledgements.push(key);
    }
    return { rates, acknowledgements };
  }
  async function download(path, filename) {
    const response = await api(path),
      blob = await response.blob(),
      url = URL.createObjectURL(blob),
      link = node('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  function renderRates(content, view, manage) {
    const form = node('form', undefined, 'price-grid');
    form.id = 'priceForm';
    for (const group of grouped(view.rates)) {
      const card = node('section', undefined, 'price-card');
      card.append(node('h2', group.name));
      for (const row of group.rows) {
        const line = node('div', undefined, 'price-row'),
          label = node('label', row.description + ' (' + row.unit + ')'),
          input = node('input');
        input.name = row.key;
        input.dataset.priceKey = row.key;
        input.value = row.unit_price;
        input.inputMode = 'decimal';
        input.autocomplete = 'off';
        input.required = !!row.editable;
        input.pattern = '\\d{1,7}(\\.\\d{1,2})?';
        input.setAttribute('aria-describedby', 'priceBounds-' + row.key);
        if (!manage || !row.editable) {
          input.disabled = true;
          input.dataset.locked = 'true';
          input.required = false;
        }
        const bounds = node(
          'p',
          (row.allow_zero ? 'Zero allowed with confirmation. ' : '') +
            'From ' +
            row.minimum +
            ' to ' +
            row.maximum +
            '.',
        );
        bounds.id = 'priceBounds-' + row.key;
        label.append(input);
        line.append(label, bounds);
        card.append(line);
        if (manage && row.allow_zero) {
          const ack = node('label', ' I confirm this zero charge is intentional.'),
            box = node('input');
          box.type = 'checkbox';
          box.name = 'ack_' + row.key;
          ack.prepend(box);
          card.append(ack);
        }
        if (!row.editable)
          card.append(node('p', 'Additional work is not enabled. This rate stays unchanged.'));
      }
      form.append(card);
    }
    if (manage) {
      const reason = node('label', 'Reason for this change');
      const area = node('textarea');
      area.name = 'change_reason';
      area.required = true;
      area.minLength = 3;
      area.maxLength = 500;
      reason.append(area);
      const actions = node('div', undefined, 'price-actions');
      form.append(reason, actions);
      actions.append(
        button('Review changes', async () => {
          if (!form.reportValidity()) {
            form.querySelector(':invalid')?.focus();
            return;
          }
          const body = collect(form);
          const preview = await jsonApi(
            '/api/companies/' + view.company_id + '/prices/preview',
            'POST',
            { ...body, change_reason: area.value },
          );
          $('priceReview')?.remove();
          content.append(
            reviewPanel(preview, () =>
              publish(view.company_id, preview).catch((e) => {
                $('pricePageStatus').textContent = e.message;
                say(e.message, 'error');
              }),
            ),
          );
          $('priceReview')?.querySelector('button')?.focus();
        }),
      );
    }
    content.append(form);
    return form;
  }
  async function publish(companyId, preview) {
    if (!preview.preview_id) return;
    const result = await jsonApi('/api/companies/' + companyId + '/prices/publish', 'POST', {
      preview_id: preview.preview_id,
      expected_generation: preview.generation,
    });
    say((result.label || 'Prices') + ' published. New pricing uses them now.', 'success');
    const session = await jsonApi('/api/session');
    state.session = {
      ...state.session,
      prices_set: session.prices_set,
      price_display: session.price_display,
      prices_not_set_message: session.prices_not_set_message,
    };
    syncNotice();
    await open();
  }
  function tools(content, base, manage, view) {
    const actions = node('div', undefined, 'price-actions');
    actions.append(
      button('Export CSV', () =>
        download(base + '/export?format=csv', 'company-prices.csv').catch((e) =>
          say(e.message, 'error'),
        ),
      ),
      button('Export spreadsheet', () =>
        download(base + '/export?format=xlsx', 'company-prices.xlsx').catch((e) =>
          say(e.message, 'error'),
        ),
      ),
    );
    if (manage) {
      const file = node('input'),
        importReason = node('input');
      file.type = 'file';
      file.accept =
        '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      file.id = 'priceImportFile';
      importReason.placeholder = 'Reason for the imported prices';
      importReason.minLength = 3;
      importReason.maxLength = 500;
      importReason.required = true;
      importReason.id = 'priceImportReason';
      actions.append(
        file,
        importReason,
        button('Import prices', async () => {
          if (!file.files?.[0]) {
            file.focus();
            throw Error('Choose a CSV or XLSX file from the template.');
          }
          if (!importReason.checkValidity()) {
            importReason.focus();
            importReason.reportValidity();
            return;
          }
          const upload = new FormData();
          upload.append('file', file.files[0]);
          upload.append('change_reason', importReason.value);
          const priceForm = $('priceForm');
          for (const key of zeroKeys)
            if (priceForm?.elements['ack_' + key]?.checked) upload.append('acknowledgements', key);
          const preview = await (
            await api(base + '/import-preview', { method: 'POST', body: upload })
          ).json();
          $('priceReview')?.remove();
          content.append(
            reviewPanel(preview, () =>
              publish(view.company_id, preview).catch((e) => say(e.message, 'error')),
            ),
          );
        }),
      );
    }
    content.append(actions);
  }
  async function history(content, base, manage, companyId) {
    const listing = await jsonApi(base + '/history'),
      card = node('section', undefined, 'price-card');
    card.append(node('h2', 'Price history'));
    if (!listing.versions.length) card.append(node('p', 'No published prices yet.'));
    for (const version of listing.versions) {
      const row = node('div', undefined, 'price-row');
      row.append(
        node(
          'p',
          version.label +
            (version.published_at ? ' · ' + new Date(version.published_at).toLocaleString() : '') +
            ' · ' +
            version.actor,
        ),
      );
      if (version.change_reason) row.append(node('p', version.change_reason));
      if (manage) {
        const restore = node('form', undefined, 'price-actions'),
          reason = node('input');
        reason.required = true;
        reason.minLength = 3;
        reason.maxLength = 500;
        reason.placeholder = 'Reason for restoring ' + version.label;
        restore.append(
          reason,
          button('Restore ' + version.label, async () => {
            if (!restore.reportValidity()) return;
            const preview = await jsonApi(
              base + '/versions/' + version.version_id + '/restore',
              'POST',
              { change_reason: reason.value },
            );
            $('priceReview')?.remove();
            content.append(
              reviewPanel(preview, () =>
                publish(companyId, preview).catch((e) => say(e.message, 'error')),
              ),
            );
          }),
        );
        row.append(restore);
      }
      card.append(row);
    }
    for (const entry of listing.events || [])
      card.append(
        node(
          'p',
          entry.actor + ' · ' + entry.action + (entry.created_at ? ' · ' + entry.created_at : ''),
        ),
      );
    content.append(card);
  }
  async function showBook(companyId, base, support) {
    const epoch = WorkspaceUI.openPage(
      support ? null : 'dashboardPrices',
      support ? 'Company prices' : 'Company prices',
      support
        ? 'Read-only. Support cannot change, import, or reprice company prices.'
        : 'Publishing applies to new pricing now. Saved drafts keep their prices until you apply new prices to one draft.',
      support ? 'READ-ONLY SUPPORT VIEW' : undefined,
    );
    const view = await jsonApi(base);
    if (epoch !== WorkspaceUI.pageEpoch()) return;
    const content = $('dashboardContent');
    content.dataset.companyId = companyId;
    const status = node('p');
    status.id = 'pricePageStatus';
    status.setAttribute('role', 'status');
    content.append(status, node('p', 'Current: ' + view.label + '. ' + view.used_for));
    const manage = !!view.can_manage && !support;
    renderRates(content, view, manage);
    tools(content, base, manage, view);
    await history(content, base, manage, companyId);
    if (epoch !== WorkspaceUI.pageEpoch()) return;
    WorkspaceUI.policy();
  }
  async function open() {
    const companyId = state.session.company_id;
    await showBook(companyId, '/api/companies/' + companyId + '/prices', false);
  }
  async function openSupport(companyId) {
    await showBook(companyId, '/api/admin/companies/' + companyId + '/prices', true);
  }
  function syncNav() {
    if (!dom() || !$('dashboardPrices') || !root.WorkspaceUI) return;
    $('dashboardPrices').hidden = !(enabled() && WorkspaceUI.can('prices_read'));
  }

  root.Prices = {
    zeroKeys,
    AFTER_HOURS_DEFAULT,
    grouped,
    afterHoursSentence,
    enabled,
    jobChargesTotal,
    noteJob,
    syncNotice,
    open,
    openSupport,
    syncNav,
  };
})(typeof window === 'undefined' ? globalThis : window);
