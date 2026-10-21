/* Drying log: per-room air, material and thermal readings over the job's days. Readings are a
   sidecar of the inspection (never pricing, documents or the signed record), so the log stays
   open for monitoring visits after signing. The server stores them; this file only shows them. */
window.DryingLog = (() => {
  let log = null,
    status = '',
    epoch = 0,
    trigger = null;
  const KINDS = ['air', 'material', 'thermal'];
  const dialog = () => $('readingDialog');
  const readable = () => !!state.session && !!state.draft?.inspection_id;
  const editable = () => readable() && (!window.WorkspaceUI?.enabled() || WorkspaceUI.can('scope'));
  const roomName = (room) => room || 'Outside & whole job';
  const time = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayLabel = (key) =>
    new Date(key + 'T12:00:00').toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  function clear() {
    ++epoch;
    log = null;
    status = '';
    if (dialog().open) dialog().close();
    render();
  }
  async function load() {
    const id = state.draft?.inspection_id,
      current = ++epoch;
    log = null;
    status = '';
    render();
    if (!readable()) return;
    if (!navigator.onLine) {
      status = 'offline';
      render();
      return;
    }
    try {
      const result = await jsonApi('/api/inspections/' + id + '/readings');
      if (current !== epoch) return;
      log = result;
    } catch (e) {
      if (current !== epoch) return;
      // A draft the server has not stored yet has no log; saving a reading syncs it first.
      if (e.status === 404 && !state.record && !state.signed)
        log = { inspection_id: id, readings: [], updated_at: null };
      else status = e.message;
    }
    render();
  }
  function readingText(r) {
    if (r.kind === 'air')
      return (
        ADRPsychro.ZONES[r.zone] +
        ' · ' +
        r.temperature_f +
        '°F · ' +
        r.relative_humidity +
        '% RH → ' +
        r.gpp +
        ' GPP · dew point ' +
        r.dew_point_f +
        '°F'
      );
    if (r.kind === 'material')
      return (
        r.material +
        ' · ' +
        r.moisture +
        ' ' +
        r.unit +
        (r.dry_standard === null || r.dry_standard === undefined
          ? ''
          : ' · dry standard ' + r.dry_standard + ' ' + r.unit) +
        (r.affected ? '' : ' · dry baseline')
      );
    return (
      'Thermal ΔT ' +
      (r.delta_t_f > 0 ? '+' : '') +
      r.delta_t_f +
      '°F · ' +
      ADRPsychro.PATTERNS[r.pattern] +
      (r.boundary ? ' · ' + r.boundary : '')
    );
  }
  function daySummary(day) {
    const parts = [];
    if (day.affected) {
      parts.push('Affected ' + day.affected.gpp + ' GPP');
      if (day.above_standard !== null)
        parts.push(
          day.above_standard > 0
            ? day.above_standard + ' GPP above the dry standard (' + day.reference.gpp + ')'
            : 'At the dry standard (' + day.reference.gpp + ' GPP)',
        );
      else parts.push('no dry reference air reading yet');
    }
    if (day.depression)
      parts.push(
        'Dehumidifier Δ' +
          day.depression.delta_gpp +
          ' GPP · ' +
          ADRPsychro.DEPRESSION[day.depression.status],
      );
    if (day.vapor)
      parts.push('vapor pressure Δ' + day.vapor.delta_inhg + ' inHg ' + day.vapor.potential);
    if (day.system)
      parts.push(
        day.system === 'open' ? 'outside air drier: open system possible' : 'closed system',
      );
    return parts.join(' · ');
  }
  function row(r, canEdit) {
    const item = node('li', undefined, 'reading');
    item.dataset.readingId = r.id;
    item.dataset.kind = r.kind;
    item.append(node('strong', readingText(r)));
    item.append(
      node(
        'span',
        time(r.taken_at) + ' · ' + r.recorded_by + (r.note ? ' · ' + r.note : ''),
        'reading-meta',
      ),
    );
    if (canEdit) {
      const remove = button('Remove', () => removeReading(r, remove));
      remove.className = 'text-action reading-remove';
      item.append(remove);
    }
    return item;
  }
  function groupCard(group, canEdit) {
    const room = state.draft.data.rooms.find((r) => r.name === group.room),
      card = node('section', undefined, 'room drying-room'),
      head = node('div', undefined, 'section-head');
    card.dataset.room = group.room;
    if (room) card.dataset.loss = roomLoss(room);
    head.append(
      node(
        'h3',
        roomName(group.room) + (group.known || !group.room ? '' : ' (room no longer listed)'),
      ),
    );
    if (canEdit) {
      const add = button('Add reading', () => openDialog(group.room, add));
      add.className = 'add-reading';
      head.append(add);
    }
    card.append(head);
    if (group.progress) {
      const p = group.progress;
      card.append(
        node(
          'p',
          'Drying progress: ' +
            p.first_gpp +
            ' → ' +
            p.latest_gpp +
            ' GPP over ' +
            plural(p.days, 'day') +
            ' · dry standard ' +
            p.reference_gpp +
            ' GPP · ' +
            p.percent +
            '% of the way',
          'drying-progress',
        ),
      );
    }
    if (!group.days.length) {
      card.append(node('p', 'No readings for this room yet.', 'hint'));
      return card;
    }
    for (const day of group.days) {
      const block = node('div', undefined, 'drying-day');
      block.append(node('h4', 'Day ' + day.number + ' · ' + dayLabel(day.key)));
      const summary = daySummary(day);
      if (summary) block.append(node('p', summary, 'drying-day-summary'));
      const list = node('ul', undefined, 'reading-list');
      for (const r of day.readings) list.append(row(r, canEdit));
      block.append(list);
      card.append(block);
    }
    return card;
  }
  function render() {
    const section = $('dryingLog');
    if (!section) return;
    const show = readable();
    // A second Check Scope card: shown with that step, and only once a job's log can be read.
    section.hidden = !show || ui.task !== 'property';
    $('logReading').hidden = !show;
    if (!show) return;
    const canEdit = editable() && navigator.onLine && !!log;
    $('addReading').hidden = !editable();
    $('addReading').disabled = !canEdit;
    $('logReading').disabled = !canEdit;
    const body = $('dryingLogBody');
    body.replaceChildren();
    if (!log) {
      $('dryingLogStatus').textContent = '';
      body.append(
        node(
          'p',
          status === 'offline'
            ? 'You are offline. Connect to load and record drying readings.'
            : status
              ? 'The drying log could not load: ' + status
              : 'Loading drying log…',
          'empty',
        ),
      );
      return;
    }
    const summary = ADRPsychro.summarizeLog(log.readings, state.draft.data.rooms);
    $('dryingLogStatus').textContent = log.readings.length
      ? plural(log.readings.length, 'reading') + ' · ' + plural(summary.days.length, 'day')
      : 'No readings yet';
    if (!log.readings.length)
      body.append(
        node(
          'p',
          'No drying readings yet. On setup day record temperature and humidity for each affected room, a dry reference room and outside, then material moisture and thermal readings as you take them. Repeat on each monitoring visit.',
          'empty',
        ),
      );
    for (const group of summary.groups) body.append(groupCard(group, canEdit));
  }
  function localInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      'T' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  }
  function setKind(kind) {
    for (const radio of dialog().querySelectorAll('input[name="readingKind"]'))
      radio.checked = radio.value === kind;
    for (const fields of dialog().querySelectorAll('fieldset[data-kind]')) {
      const active = fields.dataset.kind === kind;
      fields.hidden = !active;
      fields.disabled = !active;
    }
    calculate();
  }
  function calculate() {
    const result =
      $('readingTemp').value === '' || $('readingRh').value === ''
        ? null
        : ADRPsychro.psychrometrics($('readingTemp').value, $('readingRh').value);
    $('readingCalc').textContent = result
      ? result.gpp +
        ' GPP · dew point ' +
        result.dew_point_f +
        '°F · vapor pressure ' +
        result.vapor_pressure_inhg +
        ' inHg'
      : 'Enter temperature and humidity to calculate grains per pound and dew point.';
  }
  function openDialog(room = '', control = null) {
    if (!editable() || !log) return;
    trigger = control;
    const form = $('readingForm');
    form.reset();
    $('readingError').hidden = true;
    $('readingError').textContent = '';
    const select = $('readingRoom');
    select.replaceChildren();
    const names = state.draft.data.rooms.map((r) => r.name);
    if (room && !names.includes(room)) names.unshift(room);
    for (const name of names) {
      const option = node('option', name);
      option.value = name;
      select.append(option);
    }
    const outside = node('option', 'Outside & whole job');
    outside.value = '';
    select.append(outside);
    select.value = room;
    // The reading is being recorded now; the technician changes the time for one taken earlier.
    $('readingTakenAt').value = localInputValue(new Date());
    setKind('air');
    dialog().showModal();
    $('readingTemp').focus();
  }
  function closeDialog() {
    if (dialog().open) dialog().close();
    const control = trigger;
    trigger = null;
    if (control?.isConnected && !control.disabled) control.focus();
  }
  function payload() {
    const kind = dialog().querySelector('input[name="readingKind"]:checked').value,
      taken = new Date($('readingTakenAt').value);
    if (Number.isNaN(taken.getTime())) throw Error('Enter the date and time of the reading.');
    const base = {
      kind,
      room: $('readingRoom').value,
      taken_at: taken.toISOString(),
      note: $('readingNote').value.trim(),
    };
    if (kind === 'air')
      return {
        ...base,
        zone: $('readingZone').value,
        temperature_f: Number($('readingTemp').value),
        relative_humidity: Number($('readingRh').value),
      };
    if (kind === 'material')
      return {
        ...base,
        material: $('readingMaterial').value.trim(),
        moisture: Number($('readingMoisture').value),
        unit: $('readingUnit').value,
        dry_standard:
          $('readingDryStandard').value === '' ? null : Number($('readingDryStandard').value),
        affected: $('readingAffected').checked,
      };
    return {
      ...base,
      delta_t_f: Number($('readingDeltaT').value),
      pattern: $('readingPattern').value,
      boundary: $('readingBoundary').value.trim(),
    };
  }
  async function saveReading(event) {
    event.preventDefault();
    if (!$('readingForm').reportValidity()) return;
    const id = state.draft?.inspection_id,
      current = epoch;
    $('saveReading').disabled = true;
    try {
      const body = { reading: payload() };
      // The inspection must exist on the server before a reading can sit beside it.
      if (!state.signed && !confirmedAuthorization) await syncDraft();
      if (current !== epoch || id !== state.draft?.inspection_id) return;
      const result = await jsonApi('/api/inspections/' + id + '/readings', 'POST', body);
      if (current !== epoch || id !== state.draft?.inspection_id) return;
      log = result;
      closeDialog();
      render();
      say('Reading saved.', 'success');
    } catch (e) {
      $('readingError').textContent = e.message;
      $('readingError').hidden = false;
    } finally {
      $('saveReading').disabled = false;
    }
  }
  async function removeReading(reading, control) {
    const id = state.draft?.inspection_id,
      current = epoch;
    control.disabled = true;
    try {
      const result = await jsonApi(
        '/api/inspections/' + id + '/readings/' + encodeURIComponent(reading.id),
        'DELETE',
      );
      if (current !== epoch || id !== state.draft?.inspection_id) return;
      log = result;
      render();
      say('Reading removed.', 'success');
    } finally {
      control.disabled = false;
    }
  }
  function init() {
    $('readingForm').addEventListener('submit', saveReading);
    $('cancelReading').addEventListener('click', closeDialog);
    dialog().addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog();
    });
    for (const radio of dialog().querySelectorAll('input[name="readingKind"]'))
      radio.addEventListener('change', () => setKind(radio.value));
    for (const id of ['readingTemp', 'readingRh']) $(id).addEventListener('input', calculate);
    $('addReading').addEventListener('click', () => openDialog('', $('addReading')));
    $('logReading').addEventListener('click', () =>
      openDialog($('photoRoom').value, $('logReading')),
    );
    for (const kind of KINDS)
      if (!dialog().querySelector('fieldset[data-kind="' + kind + '"]'))
        throw Error('Reading dialog is missing the ' + kind + ' fields.');
  }
  document.addEventListener('DOMContentLoaded', init);
  return { load, clear, render, openDialog };
})();
