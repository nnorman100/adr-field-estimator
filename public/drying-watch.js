/* Monitoring is a sidecar. None of these actions enters the draft/offline save queue. */
window.DryingWatch = (() => {
  let current = null,
    loadedFor = null,
    error = '',
    summaryError = '',
    busy = false,
    epoch = 0,
    cooldown = 0,
    timer = null,
    pending = null;
  const enabled = () =>
    !!state.session?.workspaces_enabled && state.session.ai_features?.includes('drying_watch');
  const key = () =>
    [state.session?.uid, WorkspaceUI.context(), state.draft?.inspection_id].join('|');
  const signed = () =>
    enabled() && !!(state.signed || confirmedAuthorization) && !!state.draft?.inspection_id;
  const id = () => crypto.randomUUID().replaceAll('-', '');
  const time = (value) => (value ? new Date(value).toLocaleString() : 'None yet');
  const labels = {
    active: 'Monitoring',
    dry_standard_met: 'Dry standard met',
    marked_dry: 'Marked dry by staff',
    closed: 'Monitoring closed',
    overdue: 'Overdue',
    due_today: 'Due today',
    stalled: 'Stalled',
    missing_dry_standard: 'Material readings or standards missing',
    past_signed_plan: 'Past signed plan',
  };
  const plan = (watch) => `Day ${watch.day_number} of ${watch.planned_days} signed days`;
  function clear() {
    ++epoch;
    current = null;
    loadedFor = null;
    error = '';
    summaryError = '';
    busy = false;
    pending = null;
    clearTimeout(timer);
    cooldown = 0;
    render();
  }
  function failure(e) {
    if (e.status === 429) {
      cooldown = Date.now() + Math.max(1, e.retryAfter || 1) * 1000;
      clearTimeout(timer);
      timer = setTimeout(render, Math.max(1, cooldown - Date.now()));
      return `Limit reached. Retry after ${Math.max(1, e.retryAfter || 1)} seconds.`;
    }
    return e.message;
  }
  function factsCard(watch, target) {
    target.append(
      node('p', plan(watch)),
      node('p', 'Last reading: ' + time(watch.last_reading_at)),
    );
    if (watch.next_due_at) target.append(node('p', 'Next reading due: ' + time(watch.next_due_at)));
    const chips = node('div', undefined, 'watch-flags');
    for (const value of [watch.status, ...watch.flags])
      chips.append(node('span', labels[value] || value, 'watch-flag'));
    target.append(chips);
    for (const m of watch.materials)
      target.append(
        node(
          'p',
          `${m.room || 'Whole job'} · ${m.material}: ${m.moisture} ${m.unit} · reference ${m.dry_standard ?? 'not set'}`,
        ),
      );
    for (const a of watch.air)
      target.append(
        node(
          'p',
          `${a.room || 'Whole job'} · affected ${a.latest_gpp} GPP · reference ${a.reference_gpp} GPP · progress ${a.percent}%`,
        ),
      );
    if (watch.closed?.reason)
      target.append(node('p', `${labels[watch.status]}: ${watch.closed.reason}`));
    for (const note of watch.extensions)
      target.append(node('p', 'Plan extension note: ' + note.reason));
  }
  function render() {
    const card = $('dryingWatch');
    if (!card) return;
    card.hidden = !signed() || !['property', 'review'].includes(ui.task);
    if (card.hidden) return;
    card.replaceChildren(node('h2', 'Drying watch'));
    const online = navigator.onLine,
      shown = loadedFor === key() ? current : null;
    if (!online)
      card.append(node('p', 'Offline · last loaded state. Actions need a connection.', 'notice'));
    if (!shown) {
      card.append(
        node(
          'p',
          error || (online ? 'Loading drying watch…' : 'Connect to load drying watch.'),
          'watch-status',
        ),
      );
      if (error && online) card.append(button('Retry drying watch', refresh));
      return;
    }
    factsCard(shown, card);
    card.append(node('p', 'AI summary', 'eyebrow'));
    card.append(
      node(
        'p',
        shown.summary?.text || summaryError || (busy ? 'Writing summary…' : 'Summary not loaded.'),
        'watch-summary',
      ),
    );
    if (!shown.summary)
      card.append(button(summaryError ? 'Retry summary' : 'Write summary', summarize));
    card.append(
      node('p', 'Extra billable drying days require Copy to new draft and a separate agreement.'),
    );
    if (error) card.append(node('p', error, 'watch-status'));
    const actions = node('div', undefined, 'watch-actions');
    const coordination = WorkspaceUI.can('coordination');
    if (shown.status === 'active') {
      if (coordination) {
        if (!shown.reminders_enabled)
          card.append(node('p', 'The owner must enable drying reminders in Company settings.'));
        else {
          if (shown.estimator)
            actions.append(
              button('Remind ' + shown.estimator, () => approve('remind', 'estimator')),
            );
          if (shown.crew_lead)
            actions.append(button('Remind crew lead', () => approve('remind', 'crew_lead')));
          if (!shown.estimator && !shown.crew_lead)
            card.append(
              node('p', 'Assign an estimator or set a crew-lead email to send a reminder.'),
            );
        }
      }
      if (coordination || WorkspaceUI.can('scope'))
        actions.append(button('Mark dry', () => approve('mark_dry')));
      if (coordination)
        actions.append(
          button('Extend plan', () => approve('extend')),
          button('Close monitoring', () => approve('close')),
        );
    }
    for (const entry of shown.reminders.slice(-5)) {
      card.append(
        node(
          'p',
          `Reminder to ${entry.recipient === 'estimator' ? 'assigned estimator' : 'crew lead'}: ${entry.status}${entry.reason ? ' · ' + entry.reason : ''}`,
          'watch-reminder',
        ),
      );
      if (coordination && shown.reminders_enabled && entry.status === 'failed' && entry.retryable)
        actions.append(
          button('Retry reminder', () => approve('remind', entry.recipient, entry.reminder_id)),
        );
    }
    card.append(actions);
    if (pending) confirmation(card);
    if (busy)
      card.append(
        node('p', pending?.action === 'remind' ? 'Sending reminder…' : 'Loading…', 'watch-status'),
      );
    for (const control of card.querySelectorAll('button,input,textarea,select'))
      control.disabled = !online || busy || Date.now() < cooldown;
  }
  async function refresh() {
    if (!signed()) {
      clear();
      return;
    }
    const requested = key(),
      job = state.draft.inspection_id,
      gen = ++epoch;
    if (loadedFor !== requested) {
      current = null;
      pending = null;
    }
    loadedFor = requested;
    error = '';
    summaryError = '';
    busy = true;
    render();
    if (!navigator.onLine) {
      busy = false;
      render();
      return;
    }
    try {
      const result = await jsonApi('/api/jobs/' + job + '/drying-watch');
      if (gen !== epoch || key() !== requested) return;
      current = result;
    } catch (e) {
      if (gen !== epoch || key() !== requested) return;
      if ([403, 404].includes(e.status)) current = null;
      error = failure(e);
    } finally {
      if (gen === epoch) {
        busy = false;
        render();
      }
    }
    if (gen === epoch && current && !current.summary) await summarize();
  }
  async function summarize() {
    if (!signed() || busy || !navigator.onLine || Date.now() < cooldown) return;
    const requested = key(),
      gen = epoch;
    busy = true;
    summaryError = '';
    render();
    try {
      const result = await jsonApi(
        '/api/jobs/' + state.draft.inspection_id + '/drying-watch/summary',
        'POST',
      );
      if (gen === epoch && key() === requested) current = result;
    } catch (e) {
      if (gen === epoch && key() === requested)
        summaryError = 'Could not write the summary. Retry. ' + failure(e);
    } finally {
      if (gen === epoch) {
        busy = false;
        render();
      }
    }
  }
  function approve(action, recipient, reminderId) {
    pending = {
      action,
      recipient,
      recipient_hash: current.recipient_hashes?.[recipient],
      recipient_address: recipient === 'estimator' ? current.estimator : current.crew_lead,
      request_id: reminderId || id(),
      facts_hash: current.facts_hash,
      reason: '',
    };
    error = '';
    render();
    $('watchApproval')?.scrollIntoView({ block: 'nearest' });
    $('watchApproval')?.querySelector('textarea,button')?.focus();
  }
  function confirmation(card) {
    const form = node('form', undefined, 'watch-approval');
    form.id = 'watchApproval';
    const text =
      pending.action === 'remind'
        ? `Send one reminder to ${pending.recipient_address} with the address, ${plan(current)}, and last reading ${time(current.last_reading_at)}?`
        : pending.action === 'extend'
          ? 'Save a plan extension note? Extra billable days need Copy to new draft.'
          : pending.action === 'mark_dry'
            ? 'Mark this job dry with your reason?'
            : 'Close monitoring with your reason?';
    form.append(node('p', text));
    if (pending.action !== 'remind') {
      const label = node('label', 'Reason'),
        input = node('textarea');
      input.required = true;
      input.maxLength = 500;
      input.value = pending.reason;
      input.addEventListener('input', () => {
        pending.reason = input.value;
      });
      label.append(input);
      form.append(label);
    }
    const confirm = node(
      'button',
      pending.action === 'remind' ? 'Confirm and send' : 'Confirm change',
    );
    confirm.type = 'submit';
    form.append(
      confirm,
      button('Cancel', () => {
        pending = null;
        render();
      }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      commit();
    });
    card.append(form);
  }
  async function commit() {
    if (!pending || busy || !navigator.onLine || Date.now() < cooldown) return;
    const request = { ...pending },
      requested = key(),
      gen = epoch;
    const reminder = request.action === 'remind';
    busy = true;
    error = '';
    render();
    try {
      const body = reminder
        ? {
            approved: true,
            reminder_id: request.request_id,
            recipient: request.recipient,
            recipient_hash: request.recipient_hash,
            facts_hash: request.facts_hash,
          }
        : {
            approved: true,
            action: request.action,
            reason: request.reason,
            facts_hash: request.facts_hash,
            request_id: request.request_id,
          };
      const result = await jsonApi(
        '/api/jobs/' +
          state.draft.inspection_id +
          '/drying-watch/' +
          (reminder ? 'remind' : 'state'),
        'POST',
        body,
      );
      if (gen === epoch && key() === requested) {
        current = result;
        pending = null;
      }
    } catch (e) {
      if (gen === epoch && key() === requested) {
        error = failure(e);
        if (e.status === 409) {
          pending = null;
          // Approval of stale facts never loops against the same old hash.
          try {
            const updated = await jsonApi(
              '/api/jobs/' + state.draft.inspection_id + '/drying-watch',
            );
            if (gen === epoch && key() === requested) current = updated;
          } catch (reloadError) {
            if (gen === epoch && key() === requested) error = failure(reloadError);
          }
        }
      }
    } finally {
      if (gen === epoch) {
        busy = false;
        render();
      }
    }
  }
  function dashboard(target, companyId = null, openSupport = null) {
    if (!enabled() || (!state.session.role && !companyId)) return;
    const card = node('section', undefined, 'dashboard-card drying-watch-list');
    card.append(
      node(
        'h2',
        companyId
          ? 'Drying watch · read only'
          : state.session.role === 'estimator'
            ? 'My drying jobs'
            : 'Drying watch',
      ),
    );
    const body = node('div');
    card.append(body);
    target.append(card);
    const requested = [state.session.uid, WorkspaceUI.context()].join('|');
    let rows = [],
      cursor = null;
    const path = companyId
      ? `/api/admin/companies/${companyId}/drying-watch`
      : state.session.role === 'estimator'
        ? '/api/jobs/drying-watch'
        : `/api/companies/${state.session.company_id}/drying-watch`;
    async function load(more = false) {
      body.append(
        node(
          'p',
          navigator.onLine ? 'Loading drying jobs…' : 'Offline · connect to load drying jobs.',
          'watch-status',
        ),
      );
      if (!navigator.onLine) return;
      try {
        const result = await jsonApi(
          path + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        );
        if (!card.isConnected || requested !== [state.session.uid, WorkspaceUI.context()].join('|'))
          return;
        rows = more ? [...rows, ...result.jobs] : result.jobs;
        cursor = result.next_cursor;
        body.replaceChildren();
        if (!rows.length) body.append(node('p', 'No signed drying jobs yet.'));
        for (const watch of rows) {
          const row = node('article', undefined, 'watch-row');
          row.append(
            button(watch.address || 'Signed job', () =>
              openSupport ? openSupport(watch.auth_id) : restoreSigned(watch.auth_id),
            ),
          );
          factsCard(watch, row);
          if (companyId && watch.summary)
            row.append(node('p', 'AI summary', 'eyebrow'), node('p', watch.summary.text));
          body.append(row);
        }
        if (cursor) body.append(button('Older drying jobs', () => load(true)));
      } catch (e) {
        if (!card.isConnected) return;
        body.querySelector('.watch-status')?.remove();
        body.append(
          node('p', e.message),
          button('Retry drying jobs', () => load(more)),
        );
      }
    }
    load();
  }
  function supportCard(watch, target) {
    if (!enabled() || !watch) return;
    const card = node('section', undefined, 'dashboard-card');
    card.append(node('h2', 'Drying watch · read only'));
    factsCard(watch, card);
    if (watch.summary)
      card.append(node('p', 'AI summary', 'eyebrow'), node('p', watch.summary.text));
    target.append(card);
  }
  return { enabled, clear, render, refresh, dashboard, supportCard };
})();
