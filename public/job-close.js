/* A signed job's close is a private sidecar. Nothing here enters the draft or offline save queue. */
window.JobClose = (() => {
  let current = null,
    loadedFor = null,
    loading = false,
    error = '',
    editing = false,
    busy = false,
    entry = null;
  const enabled = () =>
    !!state.session?.workspaces_enabled && !!state.session.ai_features?.includes('estimate_assist');
  const key = () =>
    [state.session?.uid, WorkspaceUI.context(), state.draft?.inspection_id].join('|');
  const eligible = () =>
    enabled() &&
    WorkspaceUI.can('coordination') &&
    !!(state.signed || confirmedAuthorization) &&
    !!state.draft?.inspection_id;
  const path = () => '/api/jobs/' + state.draft.inspection_id;
  const day = (value) => new Date(value).toLocaleDateString();
  const dollars = (value) => ADRCore.money(value);

  function reset() {
    current = null;
    loadedFor = key();
    loading = false;
    error = '';
    editing = busy = false;
    entry = null;
  }
  function fresh(view) {
    current = view;
    entry = {
      amount: view.final || '',
      days: String(view.closed ? (view.actual_days ?? '') : (view.suggested_actual_days ?? '')),
      note: view.note || '',
    };
  }
  async function load() {
    const requested = key();
    if (loading || !navigator.onLine) return;
    loading = true;
    error = '';
    try {
      const view = await jsonApi(path() + '/outcome');
      if (requested !== key()) return;
      fresh(view);
    } catch (e) {
      if (requested !== key()) return;
      error = e.message;
    } finally {
      if (requested === key()) {
        loading = false;
        render();
      }
    }
  }
  async function submit() {
    const requested = key(),
      days = entry.days.trim();
    if (busy || !navigator.onLine) return;
    busy = true;
    error = '';
    render();
    try {
      const view = await jsonApi(path() + '/close', 'POST', {
        final_amount: entry.amount.trim(),
        actual_days: /^\d+$/.test(days) ? Number(days) : days || null,
        note: entry.note,
        expected_signed_at: current.signed_at,
      });
      if (requested !== key()) return;
      fresh(view);
      editing = false;
    } catch (e) {
      if (requested !== key()) return;
      error = e.message;
    } finally {
      if (requested === key()) {
        busy = false;
        render();
      }
    }
  }
  function field(label, value, change, attributes, hint) {
    const wrap = node('label', label),
      input = node(attributes.tag || 'input');
    delete attributes.tag;
    Object.assign(input, attributes);
    input.value = value;
    input.addEventListener('input', () => change(input.value));
    wrap.append(input);
    if (hint) wrap.append(node('small', hint, 'status'));
    return wrap;
  }
  function form(card) {
    const online = navigator.onLine,
      from =
        current.suggested_days_source === 'drying_watch'
          ? 'from drying watch'
          : 'from the signed plan',
      grid = node('div', undefined, 'form-grid');
    grid.append(
      field('Final invoiced amount ($)', entry.amount, (value) => (entry.amount = value), {
        id: 'jobCloseAmount',
        inputMode: 'decimal',
        pattern: '\\d{1,7}(\\.\\d{1,2})?',
        autocomplete: 'off',
      }),
      field(
        'Actual drying days',
        entry.days,
        (value) => (entry.days = value),
        { id: 'jobCloseDays', inputMode: 'numeric', pattern: '\\d*', autocomplete: 'off' },
        current.closed || current.suggested_actual_days == null ? '' : from,
      ),
      field('Note (optional)', entry.note, (value) => (entry.note = value), {
        tag: 'textarea',
        id: 'jobCloseNote',
        maxLength: 300,
        rows: 2,
      }),
    );
    const save = button(busy ? 'Saving…' : 'Record close', submit),
      actions = node('div', undefined, 'actions');
    save.id = 'jobCloseSave';
    save.disabled = busy || !online;
    actions.append(save);
    if (current.closed) {
      const cancel = button('Cancel', () => {
        fresh(current);
        editing = false;
        error = '';
        render();
      });
      cancel.disabled = busy;
      actions.append(cancel);
    }
    card.append(grid, actions);
  }
  function summary(card) {
    card.append(
      node(
        'p',
        `Closed on ${day(current.closed_at)} · invoiced ${dollars(current.final)} · landed ${current.landed_text}`,
        'job-close-result',
      ),
    );
    if (current.actual_days != null)
      card.append(node('p', 'Actual drying days: ' + current.actual_days));
    if (current.note) card.append(node('p', current.note));
    const change = button('Change', () => {
      editing = true;
      render();
    });
    change.disabled = !navigator.onLine;
    const actions = node('div', undefined, 'actions');
    actions.append(change);
    card.append(actions);
  }
  function render() {
    const card = $('jobClose');
    if (!card) return;
    card.hidden = !eligible() || !['property', 'review'].includes(ui.task);
    if (card.hidden) return;
    if (loadedFor !== key()) reset();
    if (!current && !error && !loading) load();
    card.replaceChildren(node('h2', 'Job close'));
    if (!navigator.onLine) card.append(node('p', 'Connect to record the close.', 'notice'));
    if (error) card.append(node('p', error, 'notice'));
    if (!current) {
      if (loading) card.append(node('p', 'Loading…', 'status'));
      else if (error) {
        const retry = button('Retry', () => {
          error = '';
          render();
        });
        retry.disabled = !navigator.onLine;
        card.append(retry);
      }
      return;
    }
    if (current.closed && !editing) summary(card);
    else form(card);
  }
  addEventListener('online', () => render());
  addEventListener('offline', () => render());
  return { enabled, render };
})();
