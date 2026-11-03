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
        $('afterHoursLabel').textContent = view.table?.policy
          ? afterHoursSentenceFor(view.table)
          : afterHoursSentence(view.display_rates, view.sheet_rates);
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
      actions.append(
        node('p', row.description + ': ' + (row.before || 'not set') + ' to ' + row.after),
      );
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
          const body = collect(form),
            page = WorkspaceUI.pageEpoch();
          const preview = await jsonApi(
            '/api/companies/' + view.company_id + '/prices/preview',
            'POST',
            { ...body, change_reason: area.value },
          );
          if (page !== WorkspaceUI.pageEpoch()) return;
          $('priceReview')?.remove();
          content.append(
            reviewPanel(preview, () =>
              publish(view.company_id, preview).catch((e) => say(e.message, 'error')),
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
      pricing_version: session.pricing_version,
      pricing_table_version: session.pricing_table_version,
    };
    await window.ScopeItems?.sessionChanged();
    syncNotice();
    await open();
  }
  function tools(content, base, manage, view) {
    const actions = node('form', undefined, 'price-actions'),
      // A company that starts from the catalog downloads the v2 starter template by name.
      suffix = view.starter ? '&version_id=starter' : '';
    actions.addEventListener('submit', (event) => event.preventDefault());
    actions.append(
      button('Export CSV', () =>
        download(base + '/export?format=csv' + suffix, 'company-prices.csv').catch((e) =>
          say(e.message, 'error'),
        ),
      ),
      button('Export spreadsheet', () =>
        download(base + '/export?format=xlsx' + suffix, 'company-prices.xlsx').catch((e) =>
          say(e.message, 'error'),
        ),
      ),
    );
    if (manage) {
      const file = node('input'),
        importReason = node('input'),
        zeroBox = node('input'),
        zeroLabel = node('label', undefined, 'price-check');
      file.type = 'file';
      file.accept =
        '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      file.id = 'priceImportFile';
      importReason.placeholder = 'Reason for the imported prices';
      importReason.minLength = 3;
      importReason.maxLength = 500;
      importReason.required = true;
      importReason.id = 'priceImportReason';
      zeroBox.type = 'checkbox';
      zeroBox.id = 'priceImportZero';
      zeroLabel.append(zeroBox, node('span', 'Zero prices in this file are intentional'));
      zeroLabel.hidden = !ed;
      actions.append(
        file,
        importReason,
        zeroLabel,
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
          if (zeroBox.checked) upload.append('confirm_zero_prices', 'yes');
          const page = WorkspaceUI.pageEpoch();
          const preview = await (
            await api(base + '/import-preview', { method: 'POST', body: upload })
          ).json();
          if (page !== WorkspaceUI.pageEpoch()) return;
          $('priceReview')?.remove();
          content.append(
            replacingReview(preview, () =>
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
        restore.addEventListener('submit', (event) => event.preventDefault());
        restore.append(
          reason,
          button('Restore ' + version.label, async () => {
            if (!restore.reportValidity()) return;
            const page = WorkspaceUI.pageEpoch();
            const preview = await jsonApi(
              base + '/versions/' + version.version_id + '/restore',
              'POST',
              { change_reason: reason.value },
            );
            if (page !== WorkspaceUI.pageEpoch()) return;
            $('priceReview')?.remove();
            content.append(
              replacingReview(preview, () =>
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
  /* ---- Owner price-table editor (calculation dryscope-v2) ---- */
  const GROUP_LABELS = {
    job_charges: 'Job charges',
    demolition: 'Demolition',
    treatment: 'Treatment',
    drying_equipment: 'Drying equipment',
    labor: 'Labor',
    optional_services: 'Optional services',
    extras: 'Additional work',
  };
  const GROUP_ORDER = Object.keys(GROUP_LABELS);
  const UNIT_LABELS = {
    sf: 'sq ft',
    lf: 'linear ft',
    each: 'each',
    hour: 'hour',
    day: 'day',
    unit_day: 'unit per day',
    load: 'load',
    visit: 'visit',
  };
  const FIELD_LABELS = {
    emergency_calls: 'emergency calls entered on the job',
    monitoring_hours: 'monitoring hours entered on the job',
    haul_loads: 'haul loads entered on the job',
    air_scrubbers: 'air scrubber days entered on the job',
    hepa_filters: 'HEPA filters entered on the job',
    matterport_scans: 'scans entered on the job',
    dump_truck_loads: 'dump truck loads entered on the job',
    equipment_decon: 'equipment decontaminations entered on the job',
    power_distribution: 'power distribution units entered on the job',
    labor_hours: 'labor hours entered on the job',
  };
  const SOURCE_LABELS = {
    'room:demolition:unfinished': 'Rooms: unfinished and subfloor demolition sq ft',
    'room:demolition:finished': 'Rooms: finished, drywall and trim demolition sq ft',
    'room:wet_floor': 'Rooms: wet floor sq ft',
    'room:floor': 'Rooms: floor sq ft',
    'room:basis': 'Rooms: job area (by your area setting)',
    'count_days:air_movers*drying_days': 'Air movers entered on the job times drying days',
    'count_days:dehumidifiers*drying_days': 'Dehumidifiers entered on the job times drying days',
    'count_days:wood_floor_systems*wood_floor_days':
      'Wood-floor systems entered on the job times floor drying days',
    after_hours: 'One when the job is after hours',
    typed: 'Quantity typed on the job',
    typed_count_days: 'Count and days typed on the job',
  };
  const FIELD_SOURCES = Object.keys(FIELD_LABELS).map((name) => 'field:' + name);
  const ALL_SOURCES = [
    'typed',
    'typed_count_days',
    'room:wet_floor',
    'room:floor',
    'room:basis',
    ...FIELD_SOURCES,
    'count_days:air_movers*drying_days',
    'count_days:dehumidifiers*drying_days',
    'count_days:wood_floor_systems*wood_floor_days',
    'after_hours',
  ];
  const ITEM_FIELD_LABELS = {
    name: 'name',
    customer_description: 'description on documents',
    code: 'claim code',
    group: 'group',
    unit: 'unit',
    quantity_source: 'quantity',
    default_quantity: 'starting quantity',
    waste_percent: 'waste',
    categories: 'water categories',
    taxable: 'taxable',
    allow_zero: 'zero price allowed',
    xactimate_code: 'Xactimate code',
  };
  const POLICY_LABELS = {
    estimate_mode: 'Estimate style',
    area_basis: 'Area basis',
    'range.first_sf': 'Cushion: first square feet',
    'range.first_percent': 'Cushion on the first square feet (%)',
    'range.beyond_percent': 'Cushion beyond them (%)',
    'after_hours.multiplier': 'After-hours multiplier',
    'after_hours.label': 'After-hours line label',
    'category_multipliers.1': 'Category 1 multiplier',
    'category_multipliers.2': 'Category 2 multiplier',
    'category_multipliers.3': 'Category 3 multiplier',
    'cabinetry.multiplier': 'Cabinetry multiplier',
    'cabinetry.scope': 'Cabinetry applies to',
    minimum_job_charge: 'Minimum job charge',
    overhead_profit_percent: 'Overhead and profit (%)',
    'sales_tax.enabled': 'Sales tax',
    'sales_tax.percent': 'Sales tax (%)',
    show_line_breakdown: 'Print itemized lines on the proposal',
  };
  const WARNING_WORDS = {
    large_change:
      'A price or setting changed by a lot (50% or more for a price). Check it before publishing.',
    zero_price: 'A zero price is included. Confirm that it is intentional.',
    disabled_items: 'An item was switched off or removed. New jobs will not show it.',
    mode_change: 'The estimate style changed between a range and one price.',
    tax_change: 'Sales tax settings changed.',
  };
  let ed = null;

  function groupLabel(group) {
    return GROUP_LABELS[group] || group;
  }
  function unitLabel(unit) {
    return UNIT_LABELS[unit] || unit;
  }
  function sourceLabel(source) {
    if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
    if (typeof source === 'string' && source.startsWith('field:')) {
      const text = FIELD_LABELS[source.slice(6)];
      if (text) return text.charAt(0).toUpperCase() + text.slice(1);
    }
    return String(source || '');
  }
  function sourceOptions(group) {
    if (group === 'demolition')
      return ['room:demolition:unfinished', 'room:demolition:finished', 'typed'];
    if (group === 'extras') return ['typed'];
    return [...ALL_SOURCES, 'room:demolition:unfinished', 'room:demolition:finished'];
  }
  // The unit a quantity source allows: room areas are square feet, and the server refuses a
  // square-foot demolition item that does not take its quantity from the rooms.
  function fittedUnit(group, source, unit) {
    if (group === 'extras') return 'hour';
    if (String(source).startsWith('room:')) return 'sf';
    return group === 'demolition' && unit === 'sf' ? 'lf' : unit;
  }
  function lockUnit(select, group, source) {
    const fixed = group === 'extras' || String(source).startsWith('room:');
    select.dataset.locked = fixed ? 'true' : '';
    select.disabled = fixed || !navigator.onLine;
  }
  function groupOrder(rows) {
    return grouped(
      [...(rows || [])].sort(
        (a, b) =>
          GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
          (a.sort_order || 0) - (b.sort_order || 0) ||
          String(a.item_id).localeCompare(String(b.item_id)),
      ),
    );
  }
  function slugId(name, taken) {
    let base = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(base)) base = 'item_' + base;
    base = base.slice(0, 34).replace(/_+$/, '');
    if (base.length < 2) base = 'item';
    let id = base,
      n = 2;
    while (taken.has(id)) id = base + '_' + n++;
    return id;
  }
  function uniqueCode(id, codes) {
    const base = id.toUpperCase().replace(/_/g, '-').slice(0, 12);
    let code = base,
      n = 2;
    while (codes.has(code)) code = base + '-' + n++;
    return code.slice(0, 16);
  }
  function newItem(group, name, unit, source, items) {
    const taken = new Set(items.map((item) => item.item_id)),
      codes = new Set(items.map((item) => item.code)),
      id = slugId(name, taken),
      inGroup = items.filter((item) => item.group === group);
    return {
      item_id: id,
      code: uniqueCode(id, codes),
      group,
      name: String(name).trim(),
      customer_description: '',
      unit,
      quantity_source: source,
      unit_price: '',
      allow_zero: false,
      default_quantity: '0',
      waste_percent: '0',
      categories: [],
      taxable: false,
      xactimate_code: '',
      enabled: group !== 'extras' || !inGroup.some((item) => item.enabled),
      sort_order: Math.min(10000, Math.max(-10, ...inGroup.map((i) => i.sort_order || 0)) + 10),
    };
  }
  function moveItem(items, itemId, direction) {
    const item = items.find((row) => row.item_id === itemId);
    if (!item) return items;
    const peers = items
        .filter((row) => row.group === item.group)
        .sort(
          (a, b) =>
            (a.sort_order || 0) - (b.sort_order || 0) ||
            String(a.item_id).localeCompare(String(b.item_id)),
        ),
      at = peers.indexOf(item),
      to = at + direction;
    if (to < 0 || to >= peers.length) return items;
    const other = peers[to];
    if ((other.sort_order || 0) === (item.sort_order || 0))
      peers.forEach((row, index) => (row.sort_order = index * 10));
    [item.sort_order, other.sort_order] = [other.sort_order, item.sort_order];
    return items;
  }
  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortKeys(value[key])]),
      );
    return value;
  }
  // Two tables are the same when every item and setting matches, whatever the item order.
  function canon(table) {
    const items = [...((table && table.items) || [])].sort((a, b) =>
      String(a.item_id).localeCompare(String(b.item_id)),
    );
    return JSON.stringify(sortKeys({ items, policy: (table && table.policy) || {} }));
  }
  function percentText(multiplier) {
    const percent = Math.round((Number(multiplier) - 1) * 100000) / 1000;
    return String(percent);
  }
  function money(value) {
    return '$' + Number(value).toFixed(2);
  }
  // The sentence under the After-hours box for a v2 job, built from the table the job is priced from.
  function afterHoursSentenceFor(table) {
    const policy = (table && table.policy) || {},
      charge = ((table && table.items) || []).find(
        (item) => item.quantity_source === 'after_hours' && item.unit_price !== '',
      ),
      percent = percentText(policy.after_hours?.multiplier || '1');
    const parts = [];
    if (charge) parts.push(money(charge.unit_price) + ' job charge');
    if (Number(percent) > 0) parts.push(percent + '% on labor and materials');
    return parts.length
      ? 'After-hours loss: ' + parts.join(' and ') + '.'
      : 'After-hours loss: no extra charge.';
  }
  function problemKind(problem) {
    return /enter a unit price/.test(problem.message || '') ? 'blank' : 'other';
  }
  function setPath(object, path, value) {
    const keys = path.split('.');
    let at = object;
    for (const key of keys.slice(0, -1)) at = at[key];
    at[keys[keys.length - 1]] = value;
  }
  function getPath(object, path) {
    return path.split('.').reduce((at, key) => (at == null ? at : at[key]), object);
  }
  function stamp() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function savedTime(value) {
    const at = value ? new Date(value) : null;
    return at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function unpublished() {
    if (!ed.manage) return false;
    if (ed.edits !== ed.savedEdits) return true;
    if (!ed.workingCopy) return false;
    return ed.view.starter || canon(ed.workingCopy) !== canon(ed.view);
  }
  function editStatus(text, kind) {
    const status = $('priceSaveStatus');
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind || '';
  }
  function paintBanner() {
    const banner = $('priceUnpublished');
    if (!banner || !ed) return;
    const dirty = unpublished(),
      saved = ed.edits === ed.savedEdits;
    banner.hidden = !dirty;
    if (!dirty) return;
    $('priceUnpublishedText').textContent = ed.view.starter
      ? 'These prices are ' +
        (saved ? 'saved but ' : '') +
        'not published. Jobs cannot be priced until you publish them.'
      : 'Unpublished changes' +
        (saved && ed.savedAt ? ' saved ' + ed.savedAt : '') +
        '. Jobs are still priced from ' +
        ed.view.label +
        ' until you publish.';
  }
  function paintProblems() {
    const box = $('priceProblems');
    if (!box || !ed) return;
    box.replaceChildren();
    const blanks = ed.problems.filter((p) => problemKind(p) === 'blank'),
      others = ed.problems.filter((p) => problemKind(p) !== 'blank');
    if (blanks.length)
      box.append(
        node(
          'p',
          blanks.length +
            (blanks.length === 1 ? ' item needs' : ' items need') +
            ' a price, or switch them off, before you can publish.',
        ),
      );
    for (const problem of others) box.append(node('p', problem.message));
    box.hidden = !ed.problems.length;
    for (const row of document.querySelectorAll('[data-price-item]')) {
      const mine = ed.problems.find((p) => p.item_id === row.dataset.priceItem),
        hint = row.querySelector('.price-problem');
      if (hint) hint.textContent = mine && problemKind(mine) !== 'blank' ? mine.message : '';
    }
  }
  function edited() {
    const mine = ed;
    mine.edits += 1;
    editStatus('Saving…', 'saving');
    paintBanner();
    $('priceReview')?.remove();
    clearTimeout(mine.saveTimer);
    mine.saveTimer = setTimeout(() => saveCopy(mine).catch(saveLost), 700);
    clearTimeout(mine.sampleTimer);
    mine.sampleTimer = setTimeout(() => refreshSamples().catch(() => {}), 1200);
  }
  // With the editor on screen the save status carries the failure; once it is gone only this can.
  function saveLost(error) {
    if (!$('priceSaveStatus'))
      say('Your last price change was not saved: ' + error.message, 'error');
  }
  // Only the editor on screen resends; a return to the page flushes one left behind.
  function resendCopy() {
    if (ed && $('priceSaveStatus')) saveCopy(ed).catch(saveLost);
  }
  function saveCopy(mine) {
    clearTimeout(mine.saveTimer);
    mine.chain = mine.chain.catch(() => {}).then(() => writeCopy(mine));
    return mine.chain;
  }
  async function writeCopy(mine) {
    if (mine.stale || mine.edits === mine.savedEdits) return;
    const sent = mine.edits;
    try {
      const result = await jsonApi(mine.base + '/working-copy', 'PUT', {
        items: mine.items,
        policy: mine.policy,
        acknowledgements: [...mine.acks],
        expected_working_version: mine.workingVersion,
        expected_generation: mine.view.generation || 0,
      });
      mine.workingVersion = result.working_version;
      mine.workingCopy = result.working_copy;
      mine.problems = result.problems || [];
      mine.savedAt = stamp();
      if (mine.edits === sent) mine.savedEdits = sent;
      if (ed === mine)
        editStatus(mine.edits === sent ? 'Saved ' + mine.savedAt : 'Saving…', 'saved');
    } catch (failure) {
      // The editor has no local queue, so the shared "saved locally" wording would be false here.
      const offline = !navigator.onLine,
        error = offline ? Error('You are offline.') : failure,
        conflict = /another device/i.test(error.message);
      if (conflict) mine.stale = true;
      if (ed === mine) {
        editStatus(
          conflict
            ? error.message
            : 'Not saved: ' +
                error.message +
                (offline ? ' Stay on this page and it saves when you reconnect.' : ''),
          'error',
        );
        const reload = $('priceReload');
        if (conflict && reload) reload.hidden = false;
        if (conflict)
          for (const control of document.querySelectorAll(
            '#priceEditor input,#priceEditor select,#priceEditor button,#priceUnpublished button',
          )) {
            control.dataset.locked = 'true';
            control.disabled = true;
          }
      }
      throw error;
    } finally {
      if (ed === mine) {
        paintBanner();
        paintProblems();
      }
    }
  }
  function sampleSentence(sample) {
    const range = sample.high ? sample.low + ' to ' + sample.high : sample.low;
    return (
      sample.label +
      ' prices at ' +
      range +
      '.' +
      (sample.incomplete ? ' Items with no price are left out.' : '')
    );
  }
  async function refreshSamples() {
    if (!ed || !ed.manage || !navigator.onLine) return;
    const mine = ed,
      target = $('priceSamples');
    if (!target) return;
    try {
      const result = await jsonApi(mine.base + '/calculate', 'POST', {
        items: mine.items,
        policy: mine.policy,
        acknowledgements: [...mine.acks],
      });
      if (ed !== mine) return;
      mine.samples = result.samples || [];
      mine.problems = result.problems || mine.problems;
    } catch {
      if (ed !== mine) return;
      mine.samples = [];
    }
    paintSamples();
    paintProblems();
  }
  function paintSamples() {
    const target = $('priceSamples');
    if (!target || !ed) return;
    target.replaceChildren();
    if (!ed.samples.length) {
      target.hidden = true;
      return;
    }
    target.hidden = false;
    const medium = ed.samples.find((s) => s.key === 'medium') || ed.samples[0];
    target.append(node('p', sampleSentence(medium)), node('p', medium.notice));
    const all = node('details', undefined, 'price-samples');
    all.append(node('summary', 'Show all three samples'));
    for (const sample of ed.samples)
      all.append(node('p', sampleSentence(sample) + ' ' + (sample.description || '')));
    target.append(all);
  }

  function labeled(text, input, hint) {
    const wrap = node('label', undefined, 'price-field');
    wrap.append(node('span', text), input);
    if (hint) wrap.append(node('small', hint));
    return wrap;
  }
  function textInput(value, onInput, options = {}) {
    const input = node('input');
    input.value = value ?? '';
    input.autocomplete = 'off';
    if (options.decimal) input.inputMode = 'decimal';
    if (options.max) input.maxLength = options.max;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.name) input.name = options.name;
    if (!ed.manage) {
      input.disabled = true;
      input.dataset.locked = 'true';
    }
    input.addEventListener('input', () => onInput(input.value, input));
    return input;
  }
  function checkInput(checked, onChange) {
    const box = node('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    if (!ed.manage) {
      box.disabled = true;
      box.dataset.locked = 'true';
    }
    box.addEventListener('change', () => onChange(box.checked));
    return box;
  }
  function selectInput(value, options, onChange) {
    const select = node('select');
    for (const [key, label] of options) {
      const option = node('option', label);
      option.value = key;
      select.append(option);
    }
    select.value = value;
    if (!ed.manage) {
      select.disabled = true;
      select.dataset.locked = 'true';
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }
  function radios(name, legend, value, options, onChange) {
    const group = node('fieldset', undefined, 'price-radios');
    group.append(node('legend', legend));
    for (const [key, label] of options) {
      const radio = node('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = key;
      radio.checked = key === value;
      if (!ed.manage) {
        radio.disabled = true;
        radio.dataset.locked = 'true';
      }
      radio.addEventListener('change', () => radio.checked && onChange(key));
      const wrap = node('label', undefined, 'price-radio');
      wrap.append(radio, node('span', label));
      group.append(wrap);
    }
    return group;
  }
  function policyField(path, label, hint, options = {}) {
    return labeled(
      label,
      textInput(
        getPath(ed.policy, path),
        (value) => {
          const text = value.trim();
          // The server wants a whole number here; anything else is reported when it saves.
          setPath(
            ed.policy,
            path,
            path === 'range.first_sf' && /^\d+$/.test(text) ? Number(text) : text,
          );
          edited();
        },
        { decimal: !options.text, max: options.max, name: 'policy_' + path },
      ),
      hint,
    );
  }

  function settingsCard() {
    const card = node('section', undefined, 'price-card'),
      rangeBox = node('div', undefined, 'price-subgroup');
    card.id = 'priceSettings';
    card.append(node('h2', 'Estimate settings'));
    card.append(
      radios(
        'estimate_mode',
        POLICY_LABELS.estimate_mode,
        ed.policy.estimate_mode,
        [
          ['range', 'Low to high range'],
          ['single', 'One price'],
        ],
        (value) => {
          ed.policy.estimate_mode = value;
          rangeBox.hidden = value === 'single';
          edited();
        },
      ),
      radios(
        'area_basis',
        POLICY_LABELS.area_basis,
        ed.policy.area_basis,
        [
          ['demolition', 'Demolition area'],
          ['wet_floor', 'Wet floor area'],
        ],
        (value) => {
          ed.policy.area_basis = value;
          edited();
        },
      ),
    );
    rangeBox.hidden = ed.policy.estimate_mode === 'single';
    rangeBox.append(
      node('h3', 'Range cushion'),
      policyField(
        'range.first_sf',
        'First square feet',
        'The first N sq ft get the larger cushion.',
      ),
      policyField('range.first_percent', 'Cushion on them (%)', 'Also applies to labor hours.'),
      policyField(
        'range.beyond_percent',
        'Cushion beyond them (%)',
        'Cannot be more than the first.',
      ),
    );
    card.append(rangeBox);
    const afterHours = node('div', undefined, 'price-subgroup');
    afterHours.append(
      node('h3', 'After hours'),
      policyField(
        'after_hours.multiplier',
        'Labor and materials multiplier',
        '1.000 to 2.000. The flat charge is the item whose quantity is "One when the job is after hours".',
      ),
      policyField(
        'after_hours.label',
        'Line label on documents',
        'Plain text, up to 80 characters.',
        { text: true, max: 80 },
      ),
    );
    const multipliers = node('div', undefined, 'price-subgroup');
    multipliers.append(
      node('h3', 'Multipliers'),
      policyField('category_multipliers.1', 'Category 1 rooms', '1.000 to 3.000'),
      policyField('category_multipliers.2', 'Category 2 rooms', '1.000 to 3.000'),
      policyField('category_multipliers.3', 'Category 3 or mold rooms', '1.000 to 3.000'),
      policyField('cabinetry.multiplier', 'Custom cabinetry', 'Applies to category 3 rooms.'),
      radios(
        'cabinetry_scope',
        POLICY_LABELS['cabinetry.scope'],
        ed.policy.cabinetry.scope,
        [
          ['finished_only', 'Finished-surface demolition only'],
          ['all_cat3', 'All category 3 room lines'],
        ],
        (value) => {
          ed.policy.cabinetry.scope = value;
          edited();
        },
      ),
    );
    const totals = node('div', undefined, 'price-subgroup'),
      tax = checkInput(ed.policy.sales_tax.enabled, (checked) => {
        ed.policy.sales_tax.enabled = checked;
        edited();
      }),
      taxLabel = node('label', undefined, 'price-check'),
      lines = checkInput(ed.policy.show_line_breakdown, (checked) => {
        ed.policy.show_line_breakdown = checked;
        edited();
      }),
      linesLabel = node('label', undefined, 'price-check');
    taxLabel.append(tax, node('span', 'Charge sales tax on items marked taxable'));
    linesLabel.append(lines, node('span', 'Print the itemized lines on the proposal'));
    totals.append(
      node('h3', 'Totals'),
      policyField(
        'minimum_job_charge',
        'Minimum job charge ($)',
        '0 turns it off. A job that prices lower is raised to this amount.',
      ),
      policyField(
        'overhead_profit_percent',
        'Overhead and profit (%)',
        '0 turns it off. Added before sales tax.',
      ),
      taxLabel,
      policyField('sales_tax.percent', 'Sales tax (%)', 'Up to 15.'),
      linesLabel,
    );
    card.append(afterHours, multipliers, totals);
    const samples = node('div');
    samples.id = 'priceSamples';
    samples.setAttribute('role', 'status');
    samples.hidden = true;
    card.append(samples);
    return card;
  }

  function itemRow(item) {
    const row = node('div', undefined, 'price-row price-item');
    row.dataset.priceItem = item.item_id;
    const name = labeled(
        'Name',
        textInput(
          item.name,
          (value) => {
            item.name = value;
            edited();
          },
          { max: 80 },
        ),
      ),
      price = textInput(
        item.unit_price,
        (value) => {
          item.unit_price = value.trim();
          zero.hidden = !(
            item.allow_zero &&
            Number(item.unit_price) === 0 &&
            item.unit_price !== ''
          );
          edited();
        },
        { decimal: true, placeholder: 'Price' },
      ),
      priceLabel = labeled('Price per ' + unitLabel(item.unit), price),
      on = node('label', undefined, 'price-check'),
      zero = node('label', undefined, 'price-check'),
      ack = checkInput(ed.acks.has(item.item_id), (checked) => {
        if (checked) ed.acks.add(item.item_id);
        else ed.acks.delete(item.item_id);
        edited();
      });
    price.name = 'price_' + item.item_id;
    on.append(
      checkInput(item.enabled, (checked) => {
        item.enabled = checked;
        row.classList.toggle('price-off', !checked);
        edited();
      }),
      node('span', 'Used on estimates'),
    );
    row.classList.toggle('price-off', ed.manage && !item.enabled);
    zero.append(ack, node('span', 'I confirm this zero price is intentional.'));
    zero.hidden = !(item.allow_zero && Number(item.unit_price) === 0 && item.unit_price !== '');
    row.append(name, priceLabel, zero);
    if (ed.manage) row.append(on);
    row.append(node('small', sourceLabel(item.quantity_source), 'price-source'));
    row.append(node('p', undefined, 'price-problem'));
    const more = node('details', undefined, 'price-more'),
      unitSelect = selectInput(item.unit, Object.entries(UNIT_LABELS), (value) => {
        setUnit(value);
        edited();
      }),
      setUnit = (value) => {
        item.unit = fittedUnit(item.group, item.quantity_source, value);
        unitSelect.value = item.unit;
        lockUnit(unitSelect, item.group, item.quantity_source);
        priceLabel.firstChild.textContent = 'Price per ' + unitLabel(item.unit);
      };
    if (ed.manage) lockUnit(unitSelect, item.group, item.quantity_source);
    more.append(node('summary', 'More'));
    more.append(
      labeled(
        'Description on documents',
        textInput(
          item.customer_description,
          (value) => {
            item.customer_description = value;
            edited();
          },
          { max: 300 },
        ),
        'Blank prints the name.',
      ),
      labeled('Unit', unitSelect),
      labeled(
        'Quantity comes from',
        selectInput(
          item.quantity_source,
          [...new Set([item.quantity_source, ...sourceOptions(item.group)])].map((source) => [
            source,
            sourceLabel(source),
          ]),
          (value) => {
            item.quantity_source = value;
            setUnit(item.unit);
            edited();
            row.querySelector('.price-source').textContent = sourceLabel(value);
          },
        ),
      ),
      labeled(
        'Starting quantity',
        textInput(
          item.default_quantity,
          (value) => {
            item.default_quantity = value.trim();
            edited();
          },
          { decimal: true },
        ),
        'Prefilled on new jobs. 0 means not on the job unless entered.',
      ),
      labeled(
        'Waste (%)',
        textInput(
          item.waste_percent,
          (value) => {
            item.waste_percent = value.trim();
            edited();
          },
          { decimal: true },
        ),
      ),
      labeled(
        'Xactimate code (optional)',
        textInput(
          item.xactimate_code,
          (value) => {
            item.xactimate_code = value.trim().toUpperCase();
            edited();
          },
          { max: 30 },
        ),
        'Shown on the itemized claim only. Never priced.',
      ),
    );
    const cats = node('fieldset', undefined, 'price-radios'),
      legend = node('legend', 'Water categories (none checked means all)');
    cats.append(legend);
    for (const category of [1, 2, 3]) {
      const label = node('label', undefined, 'price-check');
      label.append(
        checkInput(item.categories.includes(category), (checked) => {
          const set = new Set(item.categories);
          if (checked) set.add(category);
          else set.delete(category);
          item.categories = [...set].sort();
          edited();
        }),
        node('span', 'Category ' + category),
      );
      cats.append(label);
    }
    const taxable = node('label', undefined, 'price-check'),
      allow = node('label', undefined, 'price-check');
    taxable.append(
      checkInput(item.taxable, (checked) => {
        item.taxable = checked;
        edited();
      }),
      node('span', 'Taxable'),
    );
    allow.append(
      checkInput(item.allow_zero, (checked) => {
        item.allow_zero = checked;
        zero.hidden = !(checked && Number(item.unit_price) === 0 && item.unit_price !== '');
        edited();
      }),
      node('span', 'Allow a zero price'),
    );
    more.append(cats, taxable);
    if (ed.manage) more.append(allow);
    row.append(more);
    if (ed.manage) {
      const actions = node('div', undefined, 'price-actions');
      actions.append(
        button('Move up', () => {
          moveItem(ed.items, item.item_id, -1);
          edited();
          renderItems();
        }),
        button('Move down', () => {
          moveItem(ed.items, item.item_id, 1);
          edited();
          renderItems();
        }),
      );
      if (!ed.publishedIds.has(item.item_id))
        actions.append(
          button('Delete', () => {
            ed.items = ed.items.filter((other) => other !== item);
            ed.acks.delete(item.item_id);
            edited();
            renderItems();
          }),
        );
      row.append(actions);
    }
    return row;
  }
  function addItemForm(group) {
    const form = node('div', undefined, 'price-add'),
      name = node('input'),
      unit = selectInput('each', Object.entries(UNIT_LABELS), (value) => {
        unit.value = fittedUnit(group, source.value, value);
      }),
      source = selectInput(
        sourceOptions(group)[0],
        sourceOptions(group).map((s) => [s, sourceLabel(s)]),
        (value) => {
          unit.value = fittedUnit(group, value, unit.value);
          lockUnit(unit, group, value);
        },
      );
    name.placeholder = 'New item name';
    name.maxLength = 80;
    name.autocomplete = 'off';
    name.setAttribute('aria-label', 'New item name in ' + groupLabel(group));
    unit.value = fittedUnit(group, source.value, unit.value);
    lockUnit(unit, group, source.value);
    form.append(
      name,
      labeled('Unit', unit),
      labeled('Quantity comes from', source),
      button('Add item', () => {
        if (!name.value.trim()) {
          name.focus();
          throw Error('Name the new item first.');
        }
        ed.items.push(newItem(group, name.value, unit.value, source.value, ed.items));
        edited();
        renderItems();
        $('priceItems')
          ?.querySelector('[data-price-item="' + ed.items[ed.items.length - 1].item_id + '"] input')
          ?.focus();
      }),
    );
    return form;
  }
  function renderItems() {
    const host = $('priceItems');
    if (!host || !ed) return;
    host.replaceChildren();
    const present = groupOrder(ed.items),
      byName = new Map(present.map((g) => [g.name, g.rows]));
    for (const group of GROUP_ORDER) {
      const rows = byName.get(group) || [];
      if (!rows.length && !ed.manage) continue;
      const card = node('details', undefined, 'price-card price-group');
      card.open = ed.open.has(group);
      card.dataset.group = group;
      card.addEventListener('toggle', () => {
        if (card.open) ed.open.add(group);
        else ed.open.delete(group);
      });
      card.append(node('summary', groupLabel(group) + ' (' + rows.length + ')'));
      for (const item of rows) card.append(itemRow(item));
      if (ed.manage) card.append(addItemForm(group));
      host.append(card);
    }
    window.WorkspaceUI?.policy();
    paintProblems();
  }

  function reviewFor(preview, onPublish) {
    return Array.isArray(preview.diff)
      ? reviewPanel(preview, onPublish)
      : reviewPanelV2(preview, onPublish);
  }
  // Import and restore publish their own table, and publishing clears the saved working copy.
  function replacingReview(preview, onPublish) {
    const panel = reviewFor(preview, onPublish);
    if (ed && unpublished())
      panel
        .querySelector('h2')
        ?.after(
          node(
            'p',
            'Publishing this replaces your unpublished changes, settings included. They will be lost.',
            'price-warning',
          ),
        );
    return panel;
  }
  function diffText(row) {
    if (row.change === 'added')
      return (
        'Added ' +
        row.name +
        ' (' +
        unitLabel(row.unit) +
        ')' +
        (row.after ? ' at $' + row.after : '') +
        (row.enabled ? '' : ', switched off')
      );
    if (row.change === 'removed') return 'Removed ' + row.name;
    return (
      row.name +
      ' (' +
      unitLabel(row.unit) +
      '): ' +
      row.fields.map((change) => itemChange(change, row.percent)).join(', ')
    );
  }
  function itemChange({ field, before, after }, percent) {
    if (field === 'enabled') return 'switched ' + (after ? 'on' : 'off');
    if (field === 'sort_order') return 'moved on the list';
    if (field === 'unit_price')
      return (
        (before ? '$' + before : 'no price') +
        ' to ' +
        (after ? '$' + after : 'no price') +
        (percent ? ' (' + (Number(percent) > 0 ? '+' : '') + percent + '%)' : '')
      );
    return (
      ITEM_FIELD_LABELS[field] +
      ' ' +
      itemFieldValue(field, before) +
      ' -> ' +
      itemFieldValue(field, after)
    );
  }
  function itemFieldValue(field, value) {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (field === 'unit') return unitLabel(value);
    if (field === 'group') return groupLabel(value);
    if (field === 'quantity_source') return sourceLabel(value);
    if (field === 'waste_percent') return value + '%';
    if (field === 'categories') return value.length ? value.join(' and ') : 'all';
    return value === '' ? 'none' : String(value);
  }
  function policyValue(field, value) {
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (field === 'estimate_mode') return value === 'single' ? 'one price' : 'low to high range';
    if (field === 'area_basis') return value === 'wet_floor' ? 'wet floor area' : 'demolition area';
    if (field === 'cabinetry.scope')
      return value === 'all_cat3'
        ? 'all category 3 room lines'
        : 'finished-surface demolition only';
    return String(value);
  }
  function reviewPanelV2(preview, onPublish) {
    const panel = node('section', undefined, 'price-card');
    panel.id = 'priceReview';
    if (preview.no_changes) {
      panel.append(node('p', 'No changes from the published prices.'));
      return panel;
    }
    panel.append(node('h2', 'Review changes'));
    const items = (preview.diff && preview.diff.items) || [],
      policy = (preview.diff && preview.diff.policy) || [];
    for (const row of items) panel.append(node('p', diffText(row)));
    for (const row of policy)
      panel.append(
        node(
          'p',
          (POLICY_LABELS[row.field] || row.field) +
            ': ' +
            policyValue(row.field, row.before) +
            ' to ' +
            policyValue(row.field, row.after),
        ),
      );
    for (const warning of preview.warnings || [])
      panel.append(node('p', WARNING_WORDS[warning] || warning, 'price-warning'));
    for (const [title, list] of [
      ['Before', preview.sample_before],
      ['After', preview.sample_after],
    ])
      for (const sample of Array.isArray(list) ? list : [])
        panel.append(node('p', title + ': ' + sampleSentence(sample)));
    if (preview.sample_after?.length) panel.append(node('p', preview.sample_after[0].notice));
    if (preview.effect) panel.append(node('p', preview.effect));
    if (onPublish) {
      const actions = node('form', undefined, 'price-actions');
      actions.addEventListener('submit', (event) => event.preventDefault());
      actions.append(button('Publish prices', onPublish));
      panel.append(actions);
    }
    return panel;
  }

  async function reviewCopy(content) {
    const mine = ed;
    if (mine.stale) throw Error('Prices changed on another device. Reload.');
    const reason = $('priceReason');
    if (!reason.checkValidity()) {
      reason.focus();
      reason.reportValidity();
      throw Error('Add a short reason for this change, then review it.');
    }
    const page = WorkspaceUI.pageEpoch();
    await saveCopy(mine);
    const reviewed = mine.edits,
      said = reason.value.trim(),
      preview = await jsonApi(mine.base + '/preview', 'POST', {
        items: mine.items,
        policy: mine.policy,
        acknowledgements: [...mine.acks],
        change_reason: said,
      });
    if (page !== WorkspaceUI.pageEpoch()) return;
    if (mine.edits !== reviewed || reason.value.trim() !== said)
      throw Error('Something changed during the review. Review it again.');
    $('priceReview')?.remove();
    content.append(
      reviewFor(preview, () =>
        publish(mine.view.company_id, preview).catch((e) => say(e.message, 'error')),
      ),
    );
    window.WorkspaceUI?.policy();
    $('priceReview')?.scrollIntoView?.({ block: 'start' });
  }
  async function discardCopy() {
    // A save still waiting on its timer must not bring the copy back after the discard.
    clearTimeout(ed.saveTimer);
    clearTimeout(ed.sampleTimer);
    const mine = ed;
    mine.stale = true;
    await mine.chain.catch(() => {});
    try {
      await jsonApi(mine.base + '/working-copy/discard', 'POST');
    } catch (error) {
      mine.stale = false;
      saveCopy(mine).catch(saveLost);
      throw error;
    }
    say('Unpublished changes discarded.', 'success');
    await open();
  }
  function bannerCard(content) {
    const banner = node('section', undefined, 'price-card price-banner');
    banner.id = 'priceUnpublished';
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const text = node('p');
    text.id = 'priceUnpublishedText';
    const actions = node('form', undefined, 'price-actions'),
      confirm = node('span'),
      ask = button('Discard changes', () => {
        ask.hidden = true;
        confirm.hidden = false;
      });
    actions.addEventListener('submit', (event) => event.preventDefault());
    confirm.hidden = true;
    confirm.append(
      node('span', 'Discard everything you have not published? '),
      button('Yes, discard', () => discardCopy()),
      button('Keep editing', () => {
        confirm.hidden = true;
        ask.hidden = false;
      }),
    );
    actions.append(
      button('Publish', () => reviewCopy(content)),
      ask,
      confirm,
    );
    banner.append(text, actions);
    return banner;
  }
  async function showEditor(view, companyId, base, support) {
    const content = $('dashboardContent'),
      manage = !!view.can_manage && !support,
      source = (manage && view.working_copy) || view;
    ed = {
      view,
      base,
      manage,
      support,
      items: clone(source.items),
      policy: clone(source.policy),
      workingCopy: manage ? view.working_copy : null,
      workingVersion: view.working_copy ? view.working_copy.working_version : 0,
      publishedIds: new Set(view.starter ? [] : view.items.map((item) => item.item_id)),
      problems: [],
      samples: [],
      acks: new Set(),
      open: new Set(['job_charges', 'demolition']),
      edits: 0,
      savedEdits: 0,
      savedAt: savedTime(view.working_copy?.updated_at),
      stale: false,
      chain: Promise.resolve(),
    };
    content.dataset.companyId = companyId;
    const head = node('section', undefined, 'price-card');
    head.append(
      node('h2', view.starter ? 'Prices: not set up yet' : 'Current: ' + view.label),
      node('p', view.used_for),
    );
    if (view.starter && manage)
      head.append(
        node(
          'p',
          'This is a starter list of common items with no prices. Enter your prices, switch off what you do not use, then publish.',
        ),
      );
    if (!manage) head.append(node('p', 'Read only. Only the company owner can change prices.'));
    content.append(head);
    if (manage) {
      const save = node('p');
      save.id = 'priceSaveStatus';
      save.setAttribute('role', 'status');
      const reload = button('Reload prices', () => open());
      reload.id = 'priceReload';
      reload.hidden = true;
      content.append(bannerCard(content), save, reload);
    }
    const problems = node('div', undefined, 'price-card');
    problems.id = 'priceProblems';
    problems.hidden = true;
    const form = node('form', undefined, 'price-grid');
    form.id = 'priceEditor';
    form.addEventListener('submit', (event) => event.preventDefault());
    const items = node('div', undefined, 'price-grid');
    items.id = 'priceItems';
    form.append(settingsCard(), problems, items);
    content.append(form);
    renderItems();
    if (manage) {
      const reviewForm = node('form', undefined, 'price-card'),
        reason = node('textarea'),
        label = node('label', 'Reason for this change'),
        actions = node('div', undefined, 'price-actions');
      reviewForm.addEventListener('submit', (event) => event.preventDefault());
      reason.id = 'priceReason';
      reason.name = 'change_reason';
      reason.required = true;
      reason.minLength = 3;
      reason.maxLength = 500;
      reason.addEventListener('input', () => $('priceReview')?.remove());
      label.append(reason);
      actions.append(button('Review changes', () => reviewCopy(content)));
      reviewForm.append(label, actions);
      content.append(reviewForm);
      refreshSamples().catch(() => {});
      paintBanner();
      paintProblems();
    }
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
    // Before the flush and the reset below, so an edit still waiting survives to be saved on return.
    if (!navigator.onLine) throw Error('You are offline. Reconnect to open company prices.');
    if (ed) {
      clearTimeout(ed.sampleTimer);
      await saveCopy(ed).catch(saveLost);
    }
    ed = null;
    const view = await jsonApi(base);
    if (epoch !== WorkspaceUI.pageEpoch()) return;
    const content = $('dashboardContent'),
      tables = view.calculation_version === 'dryscope-v2' || view.starter === true,
      manage = !!view.can_manage && !support;
    content.dataset.companyId = companyId;
    if (tables) await showEditor(view, companyId, base, support);
    else {
      content.append(node('p', 'Current: ' + view.label + '. ' + view.used_for));
      renderRates(content, view, manage);
    }
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
    afterHoursSentenceFor,
    groupLabel,
    unitLabel,
    sourceLabel,
    sourceOptions,
    fittedUnit,
    diffText,
    groupOrder,
    slugId,
    newItem,
    moveItem,
    canon,
    enabled,
    jobChargesTotal,
    noteJob,
    syncNotice,
    open,
    openSupport,
    syncNav,
  };
  root.addEventListener?.('online', resendCopy);
})(typeof window === 'undefined' ? globalThis : window);
