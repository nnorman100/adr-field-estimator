/* Check Scope for a company with its own price table (calculation dryscope-v2).
   The screen lists the company's items by group with their unit prices and collects quantities.
   It never shows or computes a total: the server prices every job from the table pinned to it. */
(function (root) {
  const V2 = 'dryscope-v2';
  const GROUPS = [
    'job_charges',
    'demolition',
    'treatment',
    'drying_equipment',
    'labor',
    'optional_services',
    'extras',
  ];
  const GROUP_NAMES = {
    job_charges: 'Job charges',
    demolition: 'Demolition',
    treatment: 'Treatment',
    drying_equipment: 'Drying equipment',
    labor: 'Labor',
    optional_services: 'Optional services',
    extras: 'Additional work',
  };
  const UNIT_NAMES = {
    sf: 'sq ft',
    lf: 'linear ft',
    each: 'each',
    hour: 'hour',
    day: 'day',
    unit_day: 'unit-day',
    load: 'load',
    visit: 'visit',
  };
  // Quantities the app already measures keep their inputs, so the walkthrough fill, the IICRC sizing
  // check and readiness work unchanged. The value is [input id, largest value the input accepts].
  const FIELD_INPUTS = {
    emergency_calls: ['emergencyCalls', 100],
    monitoring_hours: ['monitoringHours', 500],
    haul_loads: ['haulLoads', 100],
    air_scrubbers: ['airScrubbers', 100],
    hepa_filters: ['hepaFilters', 100],
    matterport_scans: ['matterportScans', 100],
    dump_truck_loads: ['dumpTruckLoads', 100],
    equipment_decon: ['equipmentDecon', 100],
    power_distribution: ['powerDistribution', 100],
    labor_hours: ['laborHours', 500],
    air_movers: ['airMovers', 100],
    dehumidifiers: ['dehumidifiers', 100],
    wood_floor_systems: ['woodFloorSystems', 100],
    drying_days: ['dryingDays', 60],
    wood_floor_days: ['woodFloorDays', 60],
  };
  const COUNT_DAYS = {
    'air_movers*drying_days': ['air_movers', 'drying_days'],
    'dehumidifiers*drying_days': ['dehumidifiers', 'drying_days'],
    'wood_floor_systems*wood_floor_days': ['wood_floor_systems', 'wood_floor_days'],
  };
  const ROOM_FIELDS = {
    'room:demolition:unfinished': 'unfinished_sf',
    'room:demolition:finished': 'finished_sf',
    'room:wet_floor': 'wet_floor_sf',
    'room:floor': 'floor_sf',
    'room:basis': 'basis',
  };
  // Room measurements the walkthrough fills and the estimator may override with a reason.
  const OVERRIDE_ROOM_FIELDS = ['unfinished_sf', 'finished_sf', 'floor_sf', 'wet_floor_sf'];
  // The sheet quantities the server puts in a job that office staff create (empty scope).
  const SHEET_CHARGES = {
    emergency_calls: 1,
    monitoring_hours: 13.25,
    haul_loads: 1,
    air_scrubbers: 1,
    hepa_filters: 1,
  };

  // ---- pure helpers (also used by the node tests) ------------------------------------------
  function parseSource(text) {
    if (typeof text !== 'string') return null;
    if (ROOM_FIELDS[text]) return { kind: 'room', field: ROOM_FIELDS[text] };
    if (text === 'after_hours' || text === 'typed' || text === 'typed_count_days')
      return { kind: text };
    if (text.startsWith('field:') && FIELD_INPUTS[text.slice(6)] && text !== 'field:drying_days')
      return { kind: 'field', field: text.slice(6) };
    if (text.startsWith('count_days:') && COUNT_DAYS[text.slice(11)]) {
      const [count, days] = COUNT_DAYS[text.slice(11)];
      return { kind: 'count_days', count, days };
    }
    return null;
  }
  const isV2Table = (table) =>
    !!table && table.calculation_version === V2 && Array.isArray(table.items) && !!table.policy;
  function groupRank(name) {
    const index = GROUPS.indexOf(name);
    return index < 0 ? GROUPS.length : index;
  }
  // Enabled items in table order. A blank price means the owner has not priced it: not shown.
  function orderedItems(table) {
    if (!isV2Table(table)) return [];
    return table.items
      .filter((item) => item.enabled !== false && parseSource(item.quantity_source))
      .slice()
      .sort(
        (a, b) =>
          groupRank(a.group) - groupRank(b.group) ||
          (a.sort_order || 0) - (b.sort_order || 0) ||
          String(a.item_id).localeCompare(String(b.item_id)),
      );
  }
  // Groups for the screen: the additional-work item belongs to the Additional work panel.
  function groupsOf(table) {
    const out = [];
    for (const item of orderedItems(table)) {
      if (item.group === 'extras') continue;
      let group = out.find((g) => g.name === item.group);
      if (!group)
        out.push((group = { name: item.group, title: GROUP_NAMES[item.group], items: [] }));
      group.items.push(item);
    }
    return out;
  }
  const money = (value) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
  function unitPriceText(item) {
    if (item.unit_price === '' || item.unit_price == null) return 'Price not set';
    const price = money(item.unit_price);
    return item.unit === 'each'
      ? price + ' each'
      : price + ' per ' + (UNIT_NAMES[item.unit] || item.unit);
  }
  const formatQuantity = (value) => String(Math.round((Number(value) || 0) * 100) / 100);
  function roomArea(field, room, policy) {
    const wet = room.wet_floor_sf ?? room.floor_sf ?? 0;
    if (field === 'wet_floor_sf') return wet;
    if (field === 'floor_sf') return room.floor_sf ?? 0;
    if (field === 'basis')
      return policy?.area_basis === 'wet_floor'
        ? wet
        : (room.unfinished_sf || 0) + (room.finished_sf || 0);
    return room[field] || 0;
  }
  // "From rooms" total for one room-sourced item: matching rooms only, as the server prices them.
  function roomQuantity(item, rooms, policy) {
    const source = parseSource(item.quantity_source);
    if (!source || source.kind !== 'room') return 0;
    const wanted = (item.categories || []).map(Number);
    let total = 0;
    for (const room of rooms || []) {
      if (wanted.length && !wanted.includes(Number(room.category))) continue;
      total += Number(roomArea(source.field, room, policy)) || 0;
    }
    return Math.round(total * 100) / 100;
  }
  // A new draft starts at the table's default quantities, never the sheet's.
  function applyDefaults(data, table) {
    if (!isV2Table(table)) return data;
    const seen = new Set();
    for (const item of orderedItems(table)) {
      const source = parseSource(item.quantity_source),
        quantity = Number(item.default_quantity) || 0;
      if (source.kind === 'field' && !seen.has(source.field)) {
        seen.add(source.field);
        data[source.field] = Math.min(quantity, FIELD_INPUTS[source.field][1]);
      } else if (source.kind === 'typed' && quantity > 0)
        data.scope_items = {
          ...(data.scope_items || {}),
          [item.item_id]: { quantity, count: 0, days: 0 },
        };
    }
    return data;
  }
  // A job office staff created still carries the server's sheet quantities until an estimator edits it.
  function untouched(data) {
    return (
      !data.scope_confirmed &&
      !data.scope_items &&
      !(data.labor_hours > 0) &&
      !(data.matterport_scans > 0) &&
      Object.entries(SHEET_CHARGES).every(([key, value]) => Number(data[key]) === value)
    );
  }
  // Quantities saved for items the current table does not list as typed items.
  function unlisted(data, table) {
    const known = new Set(
      orderedItems(table)
        .filter((item) =>
          ['typed', 'typed_count_days'].includes(parseSource(item.quantity_source).kind),
        )
        .map((item) => item.item_id),
    );
    return Object.keys(data?.scope_items || {})
      .filter((id) => !known.has(id))
      .sort();
  }
  function afterHoursText(table) {
    const item = orderedItems(table).find(
      (i) => parseSource(i.quantity_source).kind === 'after_hours',
    );
    const multiplier = Number(table?.policy?.after_hours?.multiplier) || 1;
    const percent = Math.round((multiplier - 1) * 1000) / 10;
    const parts = [];
    if (item && item.unit_price !== '' && item.unit_price != null)
      parts.push(money(item.unit_price) + ' ' + item.name.toLowerCase());
    if (percent > 0) parts.push(percent + '% on labor and materials');
    return (
      'After-hours loss' +
      (parts.length ? ': ' + parts.join(' and ') : ' (no extra charge in your price list)')
    );
  }
  const reasonOk = (text) => {
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    return (
      clean.length >= 3 && clean.length <= 300 && [...clean].every((c) => c >= ' ' && c !== '\x7f')
    );
  };
  const round2 = (value) => Math.round(Number(value) * 100) / 100;
  // Rebuild data.quantity_overrides from the walkthrough's measured values: an entry exists only
  // while the entered value differs and a reason is given. reasons: key -> text typed on screen.
  function overridesFor(data, measured, reasons) {
    // Overrides saved earlier (or on another phone) stay unless this phone measured the value itself.
    const out = {};
    for (const [key, saved] of Object.entries(data.quantity_overrides || {}))
      if (!(key in (measured || {}))) out[key] = saved;
    for (const [key, was] of Object.entries(measured || {})) {
      let now;
      const split = key.lastIndexOf(':');
      if (split > 0) {
        const room = key.slice(0, split);
        now = (data.rooms || []).find((r) => r.name === room)?.[key.slice(split + 1)];
      } else now = data[key];
      if (now == null || now === '' || Number(now) === Number(was)) continue;
      const reason =
        reasons && key in reasons ? reasons[key] : data.quantity_overrides?.[key]?.reason;
      if (!reasonOk(reason)) continue;
      out[key] = {
        measured: round2(was),
        entered: round2(now),
        reason: String(reason).replace(/\s+/g, ' ').trim(),
      };
    }
    return out;
  }

  // ---- screen -------------------------------------------------------------------------------
  const dom = () =>
    typeof document !== 'undefined' && typeof document.getElementById === 'function';
  let company = null; // the company's current table, cached on the phone
  const jobs = new Map(); // inspection id -> { pricing, measured }
  const homes = new Map(); // moved element -> { parent, text }
  const snapshots = new Map(); // parent element -> its children in the original order
  const openGroups = new Set(['job_charges', 'treatment', 'drying_equipment', 'labor']);
  let seq = 0;

  const draftId = () => state?.draft?.inspection_id || null;
  const job = (id) => {
    if (!jobs.has(id)) jobs.set(id, { pricing: null, measured: {} });
    return jobs.get(id);
  };
  function companyView() {
    return isV2Table(company?.table) ? company.table : null;
  }
  // The mode follows the job's pin: a v2 company's older draft pinned at v1 keeps the v1 form.
  function active() {
    const id = draftId();
    if (!id || !state?.session) return false;
    const pinned = jobs.get(id)?.pricing?.calculation_version;
    return pinned ? pinned === V2 : state.session.pricing_version === V2;
  }
  function table() {
    const id = draftId(),
      pricing = id && jobs.get(id)?.pricing;
    return isV2Table(pricing) ? pricing : companyView();
  }
  const pricingCopy = (t) => ({
    calculation_version: t.calculation_version,
    version_id: t.version_id,
    content_sha256: t.content_sha256 ?? null,
    sequence: t.sequence ?? null,
    label: t.label ?? null,
    items: t.items,
    policy: t.policy,
  });
  // The pricing row field and the walkthrough values that persist() stores beside a draft.
  function rowExtras(id) {
    const mine = jobs.get(id);
    const t = mine?.pricing || (state?.session?.pricing_version === V2 && companyView());
    return {
      ...(t && { pricing: isV2Table(t) ? pricingCopy(t) : { ...t } }),
      ...(mine && Object.keys(mine.measured).length && { measured: mine.measured }),
    };
  }
  function seed(id, row) {
    jobs.set(id, { pricing: row?.pricing || null, measured: { ...(row?.measured || {}) } });
  }
  function forget() {
    jobs.clear();
  }

  // Company table: fetched when online, kept in the drafts store for offline launches.
  const cacheKey = () => 'prices:' + state.user.uid + ':' + state.session.company_id;
  async function loadCompany() {
    company = null;
    if (!dom() || state?.session?.pricing_version !== V2 || !state.user) return;
    const uid = state.user.uid,
      companyId = state.session.company_id;
    try {
      if (!navigator.onLine) throw Error('offline');
      const view = await jsonApi('/api/companies/' + companyId + '/prices');
      if (view.calculation_version === V2) {
        company = {
          table: pricingCopy({
            calculation_version: V2,
            version_id: view.version_id,
            sequence: view.sequence,
            label: view.label,
            items: view.items.filter((i) => i.enabled !== false),
            policy: view.policy,
          }),
          cached_at: new Date().toISOString(),
        };
        await dbAction('readwrite', (store) =>
          store.put({ key: cacheKey(), uid, company_id: companyId, prices: company }),
        ).catch(() => {});
      }
    } catch {
      const row = await dbAction('readonly', (store) => store.get(cacheKey())).catch(() => null);
      if (row?.prices?.table) company = row.prices;
    }
  }
  // A new draft for a v2 company: zero charge quantities, then the table's defaults.
  function newData(emptyData) {
    if (state?.session?.pricing_version !== V2) return null;
    return applyDefaults(emptyData({ v2: true }), companyView());
  }
  function readinessPricing() {
    if (!active()) return null;
    const t = table();
    return t ? { prices_set: true, area_basis: t.policy.area_basis || 'demolition' } : null;
  }

  // Moving an existing labelled input into a row keeps its id, so collect(), the walkthrough
  // fill, sizing and readiness keep reading it. restoreAll() puts everything back for a v1 job.
  function remember(element) {
    const parent = element.parentElement;
    if (parent && !snapshots.has(parent)) snapshots.set(parent, [...parent.children]);
    if (!homes.has(element)) homes.set(element, { text: element.firstChild?.nodeValue });
  }
  function restoreAll() {
    if (!dom()) return;
    for (const element of document.querySelectorAll('.scope-price, .override-reason'))
      if (!element.closest('.room')) element.remove();
    for (const [element, home] of homes) {
      if (home.text != null && element.firstChild?.nodeType === 3)
        element.firstChild.nodeValue = home.text;
    }
    const after = $('afterHoursLabelV2');
    if (after) {
      after.id = 'afterHoursLabel';
      if (window.Prices?.AFTER_HOURS_DEFAULT) after.textContent = window.Prices.AFTER_HOURS_DEFAULT;
    }
    for (const [parent, children] of snapshots) parent.append(...children);
  }
  function labelOf(inputId) {
    const element = $(inputId)?.closest('label');
    if (element) remember(element);
    return element;
  }
  function setLabel(label, text) {
    if (label.firstChild?.nodeType === 3) label.firstChild.nodeValue = text;
  }
  const priceNote = (item) => node('p', unitPriceText(item), 'hint scope-price');

  function reasonBlock(key) {
    const block = node('label', 'Reason for changing the walkthrough value', 'override-reason');
    const input = node('input');
    input.type = 'text';
    input.maxLength = 300;
    input.minLength = 3;
    input.autocomplete = 'off';
    input.dataset.overrideReason = key;
    input.value = state.draft?.data?.quantity_overrides?.[key]?.reason || '';
    block.append(input);
    block.hidden = true;
    input.disabled = true;
    return block;
  }
  // Show each reason box only while its value differs from what the walkthrough measured.
  function updateOverrides() {
    if (!dom() || !state?.draft) return;
    const measured = jobs.get(draftId())?.measured || {};
    for (const input of document.querySelectorAll('[data-override-reason]')) {
      const key = input.dataset.overrideReason,
        data = state.draft.data,
        split = key.lastIndexOf(':'),
        now =
          split > 0
            ? (data.rooms || []).find((r) => r.name === key.slice(0, split))?.[key.slice(split + 1)]
            : data[key],
        differs =
          key in measured && now != null && now !== '' && Number(now) !== Number(measured[key]);
      input.closest('.override-reason').hidden = !differs;
      input.disabled = !differs || !!state.signed;
      input.required = differs;
    }
  }
  // Called from changed(): keep data.quantity_overrides in step with what is on screen.
  function syncOverrides() {
    if (!dom() || !active() || !state?.draft || state.signed) return;
    const data = state.draft.data,
      measured = jobs.get(draftId())?.measured || {},
      reasons = {};
    for (const input of document.querySelectorAll('[data-override-reason]'))
      if (!input.disabled) reasons[input.dataset.overrideReason] = input.value;
    const next = overridesFor(data, measured, reasons);
    if (Object.keys(next).length) data.quantity_overrides = next;
    else delete data.quantity_overrides;
    updateOverrides();
  }
  // Remember what a walkthrough fill measured, so a later edit can be explained.
  function noteMeasured(entries, data) {
    if (!active()) return;
    const mine = job(draftId());
    for (const entry of entries || []) {
      if (typeof entry.after !== 'number') continue;
      if (entry.target === data && FIELD_INPUTS[entry.field])
        mine.measured[entry.field] = entry.after;
      else if (OVERRIDE_ROOM_FIELDS.includes(entry.field) && entry.target?.name)
        mine.measured[entry.target.name + ':' + entry.field] = entry.after;
    }
  }
  // A room measurement input: reason box under it while it differs from the walkthrough value.
  function watch(wrap, room, field) {
    if (!active() || !OVERRIDE_ROOM_FIELDS.includes(field) || !room?.name) return;
    wrap.after(reasonBlock(room.name + ':' + field));
    updateOverrides();
  }
  function wetFloorOnCard() {
    return active() && table()?.policy?.area_basis === 'wet_floor';
  }
  // The wet floor area moves from More room options to the room card when it is the pricing basis.
  function placeWetFloor(sizing, grid) {
    if (!wetFloorOnCard()) return;
    const label = sizing.querySelector('[data-room-key="wet_floor_sf"]')?.closest('label');
    if (!label) return;
    const reason = label.nextElementSibling?.matches('.override-reason')
      ? label.nextElementSibling
      : null;
    grid.append(label);
    if (reason) grid.append(reason);
  }

  function summaryOf(group, data) {
    const parts = [];
    for (const item of group.items) {
      const source = parseSource(item.quantity_source);
      if (source.kind === 'room') continue;
      if (source.kind === 'after_hours') continue;
      if (source.kind === 'field') {
        const n = Number(data[source.field]) || 0;
        if (n > 0) parts.push(formatQuantity(n) + ' ' + item.name.toLowerCase());
      } else if (source.kind === 'count_days') {
        const n = Number(data[source.count]) || 0;
        if (n > 0)
          parts.push(
            formatQuantity(n) +
              ' ' +
              item.name.toLowerCase() +
              ', ' +
              (data[source.days] || 0) +
              ' days',
          );
      } else if (source.kind === 'typed') {
        const q = data.scope_items?.[item.item_id];
        const n = Number(q ? q.quantity : item.default_quantity) || 0;
        if (n > 0) parts.push(formatQuantity(n) + ' ' + item.name.toLowerCase());
      } else if (source.kind === 'typed_count_days') {
        const q = data.scope_items?.[item.item_id];
        if (q?.count > 0)
          parts.push(q.count + ' ' + item.name.toLowerCase() + ', ' + q.days + ' days');
      }
    }
    return parts.length ? '· ' + parts.join(', ') : '· none entered';
  }
  function updateSummaries() {
    if (!dom() || !active() || !state?.draft) return;
    const t = table();
    for (const group of groupsOf(t)) {
      const note = document.querySelector('[data-group-summary="' + group.name + '"]');
      if (note) note.textContent = summaryOf(group, state.draft.data);
    }
    for (const line of document.querySelectorAll('[data-from-rooms]')) {
      const item = t.items.find((i) => i.item_id === line.dataset.fromRooms);
      if (item)
        line.textContent =
          'From rooms: ' +
          item.name +
          ' · ' +
          formatQuantity(roomQuantity(item, state.draft.data.rooms, t.policy)) +
          ' sq ft';
    }
  }

  function typedRow(item, source, data) {
    const row = node('div', undefined, 'scope-row'),
      saved = data.scope_items?.[item.item_id];
    row.dataset.itemId = item.item_id;
    const field = (label, key, value, max, step) => {
      const wrap = node('label', label),
        input = node('input');
      input.type = 'number';
      input.min = 0;
      input.max = max;
      input.step = step;
      input.inputMode = step === 1 ? 'numeric' : 'decimal';
      input.value = value;
      input.dataset.scopeItem = item.item_id;
      input.dataset.scopeKey = key;
      wrap.append(input);
      return wrap;
    };
    if (source.kind === 'typed')
      row.append(
        field(
          item.name + ' (' + (UNIT_NAMES[item.unit] || item.unit) + ')',
          'quantity',
          saved ? saved.quantity : formatQuantity(item.default_quantity),
          100000,
          0.01,
        ),
      );
    else
      row.append(
        field(item.name + ' · count', 'count', saved?.count ?? 0, 100, 1),
        field('Days', 'days', saved?.days ?? 0, 60, 1),
      );
    row.append(priceNote(item));
    return row;
  }

  function render() {
    if (!dom() || !$('v2Scope')) return;
    const on = active();
    restoreAll();
    $('v1Scope').hidden = on;
    $('v2Scope').hidden = !on;
    if ($('scopeConfirmText')) {
      $('scopeConfirmText').textContent = on
        ? "I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, labor and charge quantities for this company's price list."
        : 'I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities.';
    }
    if (!on) {
      $('v2ScopeGroups').replaceChildren();
      return;
    }
    const t = table(),
      data = state.draft.data,
      groups = $('v2ScopeGroups');
    $('v2ScopeStatus').textContent = t
      ? ''
      : "Connect once to load your company's price list. Rooms and photos still work.";
    const placed = new Set(),
      nodes = [];
    for (const group of groupsOf(t)) {
      const details = node('details', undefined, 'claim-details scope-group'),
        note = node('span', '', 'summary-note');
      details.dataset.group = group.name;
      details.open = openGroups.has(group.name);
      details.addEventListener('toggle', () =>
        details.open ? openGroups.add(group.name) : openGroups.delete(group.name),
      );
      note.dataset.groupSummary = group.name;
      details.append(node('summary', group.title + ' '));
      details.firstChild.append(note);
      for (const item of group.items) {
        const source = parseSource(item.quantity_source);
        if (source.kind === 'room') {
          const line = node('p', '', 'hint scope-from-rooms');
          line.dataset.fromRooms = item.item_id;
          details.append(line);
          continue;
        }
        if (source.kind === 'after_hours') continue; // shown once, below
        const row = node('div', undefined, 'scope-row');
        row.dataset.itemId = item.item_id;
        if (source.kind === 'typed' || source.kind === 'typed_count_days') {
          details.append(typedRow(item, source, data));
          continue;
        }
        const fields =
          source.kind === 'field'
            ? [[source.field, item.name + ' (' + (UNIT_NAMES[item.unit] || item.unit) + ')']]
            : [[source.count, item.name + ' · count']];
        for (const [field, text] of fields) {
          if (placed.has(field)) {
            row.append(node('p', item.name + ' uses the count entered above.', 'hint'));
            continue;
          }
          placed.add(field);
          const label = labelOf(FIELD_INPUTS[field][0]);
          if (!label) continue;
          setLabel(label, text);
          row.append(label, reasonBlock(field));
        }
        if (source.kind === 'count_days' && !placed.has(source.days)) {
          placed.add(source.days);
          const label = labelOf(FIELD_INPUTS[source.days][0]);
          if (label) {
            setLabel(
              label,
              source.days === 'wood_floor_days' ? 'Wood-floor drying days' : 'Drying days',
            );
            row.append(label);
          }
        }
        row.append(priceNote(item));
        details.append(row);
      }
      nodes.push(details);
    }
    // The after-hours flag is a job fact: it stays even when the table has no flat charge.
    const flag = $('afterHours')?.closest('label');
    if (flag) {
      remember(flag);
      const text = $('afterHoursLabel');
      if (text) {
        text.id = 'afterHoursLabelV2';
        text.textContent = afterHoursText(t);
      }
      const holder = nodes.find((n) => n.dataset.group === 'job_charges') || nodes[0];
      const row = node('div', undefined, 'scope-row');
      row.append(flag);
      holder ? holder.append(row) : nodes.push(row);
    }
    groups.replaceChildren(...nodes);
    // The sizing check stays available: it recommends counts from the rooms and never prices.
    const sizing = $('sizingCheck');
    if (sizing) {
      remember(sizing);
      $('v2Sizing').replaceChildren(sizing);
    }
    // Quantities saved for items the table no longer lists stay with the job, visibly.
    const orphans = unlisted(data, t);
    $('v2Unlisted').hidden = !orphans.length;
    $('v2UnlistedList').replaceChildren(
      ...orphans.map((id) => {
        const q = data.scope_items[id],
          row = node('div', undefined, 'scope-row');
        row.append(
          node(
            'p',
            id.replace(/_/g, ' ') +
              ' · ' +
              formatQuantity(q.quantity) +
              ' (' +
              q.count +
              ' × ' +
              q.days +
              ' days)',
          ),
          button('Remove', () => {
            delete state.draft.data.scope_items[id];
            if (!Object.keys(state.draft.data.scope_items).length)
              delete state.draft.data.scope_items;
            changed();
            render();
          }),
        );
        return row;
      }),
    );
    updateSummaries();
    updateOverrides();
  }

  // Called from collect(): read the typed boxes into data.scope_items, then refresh summaries.
  function collect(data) {
    if (!dom() || !active()) return;
    const boxes = [...document.querySelectorAll('[data-scope-item]')];
    if (boxes.length) {
      const items = { ...(data.scope_items || {}) },
        ids = new Set(boxes.map((box) => box.dataset.scopeItem));
      for (const id of ids) {
        const mine = boxes.filter((box) => box.dataset.scopeItem === id),
          item = table().items.find((i) => i.item_id === id),
          next = { quantity: 0, count: 0, days: 0, ...(items[id] || {}) };
        for (const box of mine) {
          const value = box.value === '' ? 0 : Number(box.value);
          next[box.dataset.scopeKey] =
            box.dataset.scopeKey === 'quantity' ? round2(value) : Math.trunc(value);
        }
        // Defaults only count while the job has no saved value; a deliberate 0 is kept.
        if (
          items[id] ||
          next.quantity ||
          next.count ||
          next.days ||
          Number(item?.default_quantity) > 0
        )
          items[id] = next;
      }
      if (Object.keys(items).length) data.scope_items = items;
      else delete data.scope_items;
    }
    updateSummaries();
    syncOverrides();
  }

  // Adopt the pinned (or effective) table the server reports for this job.
  function adopt(id, view) {
    const mine = job(id);
    const before =
      mine.pricing && (mine.pricing.version_id || '') + (mine.pricing.content_sha256 || '');
    if (view.calculation_version === V2 && view.table) {
      mine.pricing = pricingCopy({ calculation_version: V2, ...view.table });
    } else if (view.pinned)
      mine.pricing = { calculation_version: view.calculation_version || 'adr-residential-v1' };
    else mine.pricing = null;
    const after =
      mine.pricing && (mine.pricing.version_id || '') + (mine.pricing.content_sha256 || '');
    return before !== after;
  }
  // Before the form is filled: a job office staff created carries the server's sheet quantities
  // until an estimator first opens it; those become the table's defaults.
  function prepare() {
    const id = draftId();
    if (!dom() || !id || !active() || !table() || !canEdit()) return;
    if (state.record?.revision === 1 && untouched(state.draft.data)) {
      applyDefaults(state.draft.data, table());
      changed(false);
    }
  }
  async function refresh() {
    if (!dom() || !$('v2Scope')) return;
    const id = draftId();
    render();
    if (!id || !navigator.onLine || !state.record || !state.session?.price_books_enabled) return;
    const mine = ++seq;
    try {
      const view = await jsonApi('/api/inspections/' + id + '/pricing');
      if (mine !== seq || draftId() !== id) return;
      if (adopt(id, view)) schedulePersist();
      render();
    } catch {
      /* the saved screen stays: a job not on the server yet has no pin to read */
    }
  }
  const canEdit = () =>
    !state.signed && (!window.WorkspaceUI?.enabled() || WorkspaceUI.can('scope'));

  root.ScopeItems = {
    GROUP_NAMES,
    UNIT_NAMES,
    parseSource,
    orderedItems,
    groupsOf,
    unitPriceText,
    formatQuantity,
    roomQuantity,
    applyDefaults,
    untouched,
    unlisted,
    afterHoursText,
    overridesFor,
    reasonOk,
    summaryOf,
    active,
    table,
    loadCompany,
    newData,
    readinessPricing,
    rowExtras,
    seed,
    forget,
    prepare,
    refresh,
    render,
    collect,
    syncOverrides,
    noteMeasured,
    watch,
    placeWetFloor,
    wetFloorOnCard,
  };
})(typeof window === 'undefined' ? globalThis : window);
