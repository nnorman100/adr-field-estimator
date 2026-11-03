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
  const TYPED_COUNT_MAX = 100;
  // Job fields the server stores as decimals; every other field quantity is a whole number.
  const DECIMAL_FIELDS = ['monitoring_hours', 'labor_hours'];
  // Room measurements the walkthrough fills and the estimator may override with a reason.
  const OVERRIDE_ROOM_FIELDS = ['unfinished_sf', 'finished_sf', 'floor_sf', 'wet_floor_sf'];
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
  // The server prices a non-room item only if a room on the job has one of its categories.
  function appliesToRooms(item, rooms) {
    return !item.categories?.length || (rooms || []).some((room) => coversRoom(item, room));
  }
  // A row stays while it can be priced, or while it holds a change that still needs its reason box.
  function keepsRow(item, data) {
    const source = parseSource(item.quantity_source);
    if (source.kind === 'room' || appliesToRooms(item, data.rooms)) return true;
    return [source.field, source.count, source.days].some((key) =>
      differs(data.quantity_overrides?.[key]),
    );
  }
  // Groups for the screen: the additional-work item belongs to the Additional work panel. Given the
  // job, only the rows it can use.
  function groupsOf(table, data) {
    const out = [];
    for (const item of orderedItems(table)) {
      if (item.group === 'extras' || (data && !keepsRow(item, data))) continue;
      let group = out.find((g) => g.name === item.group);
      if (!group)
        out.push((group = { name: item.group, title: GROUP_NAMES[item.group], items: [] }));
      group.items.push(item);
    }
    return out;
  }
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  // The server stores these quantities as Decimals and returns them as strings: the same text here
  // keeps a saved draft equal to the server's copy, so it never reads as a sync conflict.
  const decimalText = (value) => String(round2(value));
  const money = (value) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
  function unitPriceText(item) {
    if (item.unit_price === '' || item.unit_price == null) return 'Price not set';
    const price = money(item.unit_price);
    return item.unit === 'each'
      ? price + ' each'
      : price + ' per ' + (UNIT_NAMES[item.unit] || item.unit);
  }
  const formatQuantity = decimalText;
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
  function coversRoom(item, room) {
    const wanted = (item.categories || []).map(Number);
    return !wanted.length || wanted.includes(Number(room.category));
  }
  function roomQuantity(item, rooms, policy) {
    const source = parseSource(item.quantity_source);
    if (!source || source.kind !== 'room') return 0;
    let total = 0;
    for (const room of rooms || []) {
      if (!coversRoom(item, room)) continue;
      total += Number(roomArea(source.field, room, policy)) || 0;
    }
    return Math.round(total * 100) / 100;
  }
  function pricesFromWetFloor(table, room) {
    return orderedItems(table).some(
      (item) =>
        parseSource(item.quantity_source).field === 'wet_floor_sf' && coversRoom(item, room),
    );
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
        const capped = Math.min(quantity, FIELD_INPUTS[source.field][1]);
        data[source.field] = DECIMAL_FIELDS.includes(source.field) ? capped : Math.trunc(capped);
      } else if (source.kind === 'count_days' && !seen.has(source.count)) {
        seen.add(source.count);
        data[source.count] = Math.trunc(Math.min(quantity, FIELD_INPUTS[source.count][1]));
      } else if (source.kind === 'typed' && quantity > 0)
        data.scope_items = {
          ...(data.scope_items || {}),
          [item.item_id]: { quantity: decimalText(quantity), count: 0, days: 0 },
        };
      else if (source.kind === 'typed_count_days' && quantity > 0)
        data.scope_items = {
          ...(data.scope_items || {}),
          [item.item_id]: {
            quantity: '0',
            count: Math.trunc(Math.min(quantity, TYPED_COUNT_MAX)),
            days: data.drying_days,
          },
        };
    }
    data.seeded_from_version = table.version_id;
    return data;
  }
  // Quantities saved for items the current table does not list as typed items.
  function unlisted(data, table) {
    if (!isV2Table(table)) return [];
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
  // Job-field quantities (not day counts) whose item the current table no longer lists.
  function unlistedFields(data, table) {
    if (!isV2Table(table)) return [];
    const listed = new Set();
    for (const item of orderedItems(table)) {
      const source = parseSource(item.quantity_source);
      listed.add(source.field).add(source.count);
    }
    return Object.keys(FIELD_INPUTS)
      .filter(
        (field) =>
          !['drying_days', 'wood_floor_days'].includes(field) &&
          !listed.has(field) &&
          Number(data?.[field]) > 0,
      )
      .sort();
  }
  // Quantities saved for items no room on this job can price.
  function offCategory(data, table) {
    return orderedItems(table)
      .filter((item) => {
        const kind = parseSource(item.quantity_source).kind;
        return item.group !== 'extras' && kind !== 'after_hours' && !keepsRow(item, data);
      })
      .map((item) => enteredText(item, data))
      .filter(Boolean);
  }
  function fromRoomsText(item, rooms, policy) {
    return (
      'From rooms: ' +
      item.name +
      ' · ' +
      formatQuantity(roomQuantity(item, rooms, policy)) +
      ' ' +
      (UNIT_NAMES[item.unit] || item.unit) +
      ' · ' +
      unitPriceText(item)
    );
  }
  function afterHoursText(table, rooms) {
    const item = orderedItems(table).find(
      (i) => parseSource(i.quantity_source).kind === 'after_hours' && appliesToRooms(i, rooms),
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
  const cleanReason = (text) =>
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  // The server's rule (backend/contracts.py QuantityOverride): 3 to 300 printable characters.
  const reasonOk = (text) => {
    const clean = cleanReason(text);
    return (
      [...clean].length >= 3 &&
      clean.length <= 300 &&
      !/[\p{C}\p{Z}]/u.test(clean.replace(/ /g, ''))
    );
  };
  const roomField = (key) => {
    const split = key.lastIndexOf(':');
    return split < 0 ? null : { room: key.slice(0, split), field: key.slice(split + 1) };
  };
  // The job's current value for an override key; undefined when its room is gone.
  function overrideValue(data, key) {
    const parts = roomField(key);
    if (!parts) return data[key] ?? 0;
    const room = (data.rooms || []).find((r) => r.name === parts.room);
    return room && (room[parts.field] ?? 0);
  }
  const differs = (entry) => !!entry && Number(entry.entered) !== Number(entry.measured);
  // data.quantity_overrides holds every walkthrough-filled value. Keep each entry's entered value
  // current; a reason is kept only while the value differs. reasons: key -> text typed on screen.
  function overridesFor(data, reasons) {
    const out = {};
    for (const [key, saved] of Object.entries(data.quantity_overrides || {})) {
      const now = overrideValue(data, key);
      if (now === undefined) continue;
      const entry = { measured: saved.measured, entered: decimalText(now) };
      if (differs(entry)) {
        const reason = reasons && key in reasons ? reasons[key] : saved.reason;
        if (reasonOk(reason)) entry.reason = cleanReason(reason);
      } else entry.entered = saved.measured;
      out[key] = entry;
    }
    return out;
  }
  // A changed walkthrough value with no reason yet: the server refuses to save it.
  const missingReason = (data) =>
    Object.values(data?.quantity_overrides || {}).some(
      (entry) => differs(entry) && !reasonOk(entry.reason),
    );
  function renamedOverrides(overrides, from, to) {
    return Object.fromEntries(
      Object.entries(overrides).map(([key, entry]) => {
        const parts = roomField(key);
        return [parts?.room === from ? to + ':' + parts.field : key, entry];
      }),
    );
  }

  // ---- screen -------------------------------------------------------------------------------
  const dom = () =>
    typeof document !== 'undefined' && typeof document.getElementById === 'function';
  let company = null; // the company's current table, cached on the phone
  const jobs = new Map(); // inspection id -> { pricing }
  let rendered = null; // the form and table the screen was last built for
  let renderedRows = null; // the item rows it was last built with
  const homes = new Map(); // moved element -> { parent, text }
  const snapshots = new Map(); // parent element -> its children in the original order
  const openGroups = new Set(['job_charges', 'treatment', 'drying_equipment', 'labor']);
  let seq = 0;
  let companySeq = 0;

  const draftId = () => state?.draft?.inspection_id || null;
  const job = (id) => {
    if (!jobs.has(id)) jobs.set(id, { pricing: null });
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
  // The pricing row field that persist() stores beside a draft.
  function rowExtras(id) {
    const t = jobs.get(id)?.pricing || (state?.session?.pricing_version === V2 && companyView());
    return t ? { pricing: isV2Table(t) ? pricingCopy(t) : { ...t } } : {};
  }
  function seed(id, row) {
    jobs.set(id, { pricing: row?.pricing || null });
  }
  function forget() {
    jobs.clear();
  }

  // Company table: fetched when online, kept in the drafts store for offline launches.
  const cacheKey = () => 'prices:' + state.user.uid + ':' + state.session.company_id;
  async function loadCompany() {
    const mine = ++companySeq;
    if (!dom() || state?.session?.pricing_version !== V2 || !state.user) {
      company = null;
      return;
    }
    const uid = state.user.uid,
      companyId = state.session.company_id;
    try {
      if (!navigator.onLine) throw Error('offline');
      const view = await jsonApi('/api/companies/' + companyId + '/prices');
      if (mine !== companySeq) return;
      company = null;
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
      if (mine === companySeq) company = row?.prices?.table ? row.prices : null;
    }
  }
  // A new draft for a v2 company: zero charge quantities, then the table's defaults.
  function newData(emptyData) {
    if (state?.session?.pricing_version !== V2) return null;
    return applyDefaults(emptyData({ v2: true }), companyView());
  }
  function readinessPricing() {
    const id = draftId();
    if (state?.session?.prices_set === false && !(id && jobs.get(id)?.pricing))
      return { prices_set: false };
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
    const overrides = state.draft.data.quantity_overrides || {};
    for (const input of document.querySelectorAll('[data-override-reason]')) {
      const open = differs(overrides[input.dataset.overrideReason]);
      input.closest('.override-reason').hidden = !open;
      if (!open) input.value = '';
      input.disabled = !open || !!state.signed;
      input.setCustomValidity(
        open && !reasonOk(input.value) ? 'Enter a short reason (at least 3 characters).' : '',
      );
      if (input === validationControl && input.validity.valid) clearValidationFeedback();
    }
  }
  // Called from changed(): keep data.quantity_overrides in step with what is on screen.
  function syncOverrides() {
    if (!dom() || !state?.draft || state.signed) return;
    const data = state.draft.data,
      reasons = {};
    for (const input of document.querySelectorAll('[data-override-reason]'))
      if (!input.disabled) reasons[input.dataset.overrideReason] = input.value;
    const next = overridesFor(data, reasons);
    if (Object.keys(next).length) data.quantity_overrides = next;
    else delete data.quantity_overrides;
    if (active() && rowsKey(table(), data) !== renderedRows) render();
    else {
      updateSummaries();
      updateOverrides();
    }
  }
  const entryKey = (entry, data) => {
    if (entry.target === data) return FIELD_INPUTS[entry.field] ? entry.field : null;
    return OVERRIDE_ROOM_FIELDS.includes(entry.field) && entry.target?.name
      ? entry.target.name + ':' + entry.field
      : null;
  };
  // Record on the job what a walkthrough fill measured, so a later edit must be explained on any phone.
  function noteMeasured(entries, data) {
    for (const entry of entries || []) {
      const key = entryKey(entry, data);
      if (!key || typeof entry.after !== 'number') continue;
      if (!active() && !data.quantity_overrides?.[key]) continue;
      data.quantity_overrides ||= {};
      if (!('priorOverride' in entry)) entry.priorOverride = data.quantity_overrides[key] || null;
      const value = decimalText(entry.after);
      data.quantity_overrides[key] = { measured: value, entered: value };
    }
  }
  // Undo returns the value the fill replaced, so what that fill measured no longer applies.
  function undoMeasured(entry, data) {
    const key = entryKey(entry, data);
    if (!key || !data.quantity_overrides) return;
    if (entry.priorOverride) data.quantity_overrides[key] = entry.priorOverride;
    else delete data.quantity_overrides[key];
  }
  // A room's walkthrough values and their reason boxes follow its new name.
  function renameRoom(from, to, data) {
    if (from === to || !data?.quantity_overrides) return;
    data.quantity_overrides = renamedOverrides(data.quantity_overrides, from, to);
    if (!dom()) return;
    for (const input of document.querySelectorAll('[data-override-reason]')) {
      const parts = roomField(input.dataset.overrideReason);
      if (parts?.room === from) input.dataset.overrideReason = to + ':' + parts.field;
    }
  }
  // A room measurement input: reason box under it while it differs from the walkthrough value.
  function watch(wrap, room, field) {
    if (!OVERRIDE_ROOM_FIELDS.includes(field) || !room?.name) return;
    const key = room.name + ':' + field;
    if (!active() && !state.draft.data.quantity_overrides?.[key]) return;
    wrap.after(reasonBlock(key));
    updateOverrides();
  }
  function wetFloorOnCard() {
    return active() && table()?.policy?.area_basis === 'wet_floor';
  }
  // A mold room has no drying check, but any area a price list prices it from needs an input, and a
  // value that needs a reason must stay reachable. Everything shows on a water room.
  function fitSizing(sizing, room, mold) {
    const overridden = (field) =>
      !!state.draft?.data?.quantity_overrides?.[room.name + ':' + field];
    const hide = (field, hidden) => {
      const label = sizing.querySelector('[data-room-key="' + field + '"]')?.closest('label');
      if (label) label.hidden = hidden;
    };
    const showFloor = !mold || active() || overridden('floor_sf'),
      showWet =
        !mold ||
        wetFloorOnCard() ||
        (active() && pricesFromWetFloor(table(), room)) ||
        overridden('wet_floor_sf');
    sizing.hidden = !showFloor && !showWet;
    sizing.querySelector('.room-sizing-title').hidden = mold;
    hide('ceiling_height_ft', mold);
    hide('water_class', mold);
    hide('floor_sf', !showFloor);
    hide('wet_floor_sf', !showWet);
    sizing.querySelector('.wet-floor-hint').hidden = !showWet;
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

  function enteredText(item, data) {
    const source = parseSource(item.quantity_source),
      name = item.name.toLowerCase();
    if (source.kind === 'field') {
      const n = Number(data[source.field]) || 0;
      return n > 0 ? formatQuantity(n) + ' ' + name : '';
    }
    if (source.kind === 'count_days') {
      const n = Number(data[source.count]) || 0;
      return n > 0
        ? formatQuantity(n) + ' ' + name + ', ' + (data[source.days] || 0) + ' days'
        : '';
    }
    const q = data.scope_items?.[item.item_id];
    if (source.kind === 'typed') {
      const n = Number(q?.quantity) || 0;
      return n > 0 ? formatQuantity(n) + ' ' + name : '';
    }
    if (source.kind === 'typed_count_days' && q?.count > 0)
      return q.count + ' ' + name + ', ' + q.days + ' days';
    return '';
  }
  function summaryOf(group, data) {
    const parts = group.items.map((item) => enteredText(item, data)).filter(Boolean);
    return parts.length ? '· ' + parts.join(', ') : '· none entered';
  }
  const rowsKey = (t, data) =>
    groupsOf(t, data)
      .flatMap((group) => group.items.map((item) => item.item_id))
      .join();
  function readOnlyRow(text) {
    const row = node('div', undefined, 'scope-row');
    row.append(node('p', text));
    return row;
  }
  function updateSummaries() {
    if (!dom() || !active() || !state?.draft) return;
    const t = table();
    for (const group of groupsOf(t, state.draft.data)) {
      const note = document.querySelector('[data-group-summary="' + group.name + '"]');
      if (note) note.textContent = summaryOf(group, state.draft.data);
    }
    for (const line of document.querySelectorAll('[data-from-rooms]')) {
      const item = t.items.find((i) => i.item_id === line.dataset.fromRooms);
      if (item) line.textContent = fromRoomsText(item, state.draft.data.rooms, t.policy);
    }
    const offRows = offCategory(state.draft.data, t);
    $('v2OffCategory').hidden = !offRows.length;
    $('v2OffCategoryList').replaceChildren(...offRows.map(readOnlyRow));
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
          saved ? saved.quantity : 0,
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

  const shownView = () => (active() ? 'v2:' + (table()?.version_id || '') : 'v1');
  function render() {
    if (!dom() || !$('v2Scope')) return;
    const on = active();
    rendered = shownView();
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
      for (const key of Object.keys(state?.draft?.data?.quantity_overrides || {})) {
        const label = FIELD_INPUTS[key] && labelOf(FIELD_INPUTS[key][0]);
        if (label) label.after(reasonBlock(key));
      }
      updateOverrides();
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
    renderedRows = rowsKey(t, data);
    for (const group of groupsOf(t, data)) {
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
            row.append(label, reasonBlock(source.days));
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
        text.textContent = afterHoursText(t, data.rooms);
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
    const orphans = unlisted(data, t),
      fields = unlistedFields(data, t);
    $('v2Unlisted').hidden = !orphans.length && !fields.length;
    $('v2UnlistedList').replaceChildren(
      ...fields.map((field) =>
        readOnlyRow(field.replace(/_/g, ' ') + ' · ' + formatQuantity(data[field])),
      ),
      ...orphans.map((id) => {
        const q = data.scope_items[id];
        return readOnlyRow(
          id.replace(/_/g, ' ') +
            ' · ' +
            formatQuantity(q.quantity) +
            ' (' +
            q.count +
            ' × ' +
            q.days +
            ' days)',
        );
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
          next = { quantity: '0', count: 0, days: 0, ...(items[id] || {}) };
        for (const box of mine) {
          const value = box.value === '' ? 0 : Number(box.value);
          next[box.dataset.scopeKey] =
            box.dataset.scopeKey === 'quantity' ? decimalText(value) : Math.trunc(value);
        }
        // A saved value stays, including a deliberate 0.
        if (items[id] || Number(next.quantity) || next.count || next.days) items[id] = next;
      }
      if (Object.keys(items).length) data.scope_items = items;
      else delete data.scope_items;
    }
    syncOverrides();
  }

  // Adopt the pinned (or effective) table the server reports for this job.
  function adopt(id, view) {
    const mine = job(id);
    const before =
      mine.pricing && (mine.pricing.version_id || '') + (mine.pricing.content_sha256 || '');
    if (view.calculation_version === V2 && view.table) {
      mine.pricing = pricingCopy({ calculation_version: V2, ...view.table });
    } else if (view.pinned || view.calculation_version)
      mine.pricing = { calculation_version: view.calculation_version || 'adr-residential-v1' };
    else mine.pricing = null;
    const after =
      mine.pricing && (mine.pricing.version_id || '') + (mine.pricing.content_sha256 || '');
    return before !== after;
  }
  // What the screen should show has changed. Quantities stay as they are: a job is seeded once, at
  // New job on the phone or at office create on the server.
  function settle() {
    render();
    renderRooms();
    renderReadiness();
  }
  // Read the job's pin from the server. The screen is rebuilt only if that changes what it shows,
  // so a technician mid-entry keeps focus and whatever is partly typed.
  async function pull() {
    if (!dom() || !$('v2Scope')) return;
    const id = draftId();
    if (!id || !navigator.onLine || !state.record || !state.session?.price_books_enabled) return;
    const mine = ++seq;
    try {
      const view = await jsonApi('/api/inspections/' + id + '/pricing');
      if (mine !== seq || draftId() !== id) return;
      if (adopt(id, view)) schedulePersist();
      if (shownView() !== rendered) settle();
    } catch {
      /* the saved screen stays: a job not on the server yet has no pin to read */
    }
  }
  async function refresh() {
    render();
    await pull();
  }
  // The session changed after sign-in, or an earlier reload failed: the company table may have
  // appeared, gone, been republished or moved company.
  const tableStale = (before) =>
    before?.pricing_version !== state.session?.pricing_version ||
    before?.pricing_table_version !== state.session?.pricing_table_version ||
    before?.company_id !== state.session?.company_id ||
    (state.session?.pricing_version === V2 &&
      companyView()?.version_id !== state.session.pricing_table_version);
  async function sessionChanged() {
    await loadCompany();
    if (!dom() || !draftId() || !$('v2Scope')) return;
    if (shownView() !== rendered) settle();
    await pull();
  }
  root.ScopeItems = {
    GROUP_NAMES,
    UNIT_NAMES,
    parseSource,
    orderedItems,
    groupsOf,
    unitPriceText,
    formatQuantity,
    roomQuantity,
    pricesFromWetFloor,
    applyDefaults,
    unlisted,
    unlistedFields,
    offCategory,
    appliesToRooms,
    fromRoomsText,
    afterHoursText,
    overridesFor,
    missingReason,
    reasonOk,
    summaryOf,
    active,
    table,
    loadCompany,
    tableStale,
    sessionChanged,
    newData,
    readinessPricing,
    rowExtras,
    seed,
    forget,
    refresh,
    pull,
    render,
    collect,
    syncOverrides,
    noteMeasured,
    undoMeasured,
    renameRoom,
    watch,
    fitSizing,
    placeWetFloor,
    wetFloorOnCard,
  };
})(typeof window === 'undefined' ? globalThis : window);
