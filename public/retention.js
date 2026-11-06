/* How long the company keeps each kind of record. The owner chooses the days; the server holds the
   setting, writes the sentences and runs the deletion. Nothing here is queued offline. */
(function (root) {
  const LABELS = {
    invitations: 'Invitations',
    admin_events: 'Company activity log',
    job_monitoring: 'Drying-watch history',
    evidence_photos: 'Photos on archived drafts',
  };
  const ORDER = Object.keys(LABELS);
  const plural = (days) => (days === 1 ? '1 day' : days + ' days');

  /* The sentence for one kind of record at the days entered, or a hint while the number is out of
     range, so the effect shown is always the one Save would keep. */
  function sentence(view, name, value) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < view.min_days || days > view.max_days)
      return `Enter ${view.min_days} to ${view.max_days} days.`;
    return view.templates[name].replace('{days}', plural(days));
  }

  function chosen(view, values) {
    const days = {};
    for (const name of ORDER) {
      const value = Number(values[name]);
      if (!Number.isInteger(value) || value < view.min_days || value > view.max_days)
        throw Error(`${LABELS[name]}: enter ${view.min_days} to ${view.max_days} days.`);
      days[name] = value;
    }
    return days;
  }

  /* Days that are shorter than the saved setting: what Save would start deleting sooner. */
  const shortened = (view, days) => ORDER.filter((name) => days[name] < view.days[name]);

  function runLine(view) {
    if (!view.running)
      return 'Automatic deletion is not switched on yet, so nothing is deleted. These settings apply once it is.';
    if (!view.last_run_at)
      return 'Deletion runs once a day, when someone in your company opens the app.';
    const count = Object.values(view.last_deleted || {}).reduce((a, b) => a + b, 0);
    return `Deletion runs once a day. Last run ${new Date(view.last_run_at).toLocaleDateString()}: ${count} ${count === 1 ? 'record' : 'records'} deleted.`;
  }

  const route = (companyId) => '/api/companies/' + companyId + '/retention';

  async function section(target, companyId) {
    if (!WorkspaceUI.can('retention_manage')) return;
    const card = node('section', undefined, 'dashboard-card record-retention');
    card.id = 'recordRetention';
    card.setAttribute('aria-labelledby', 'recordRetentionHeading');
    const heading = node('h2', 'How long records are kept');
    heading.id = 'recordRetentionHeading';
    card.append(heading);
    target.append(card);
    let view;
    try {
      view = await jsonApi(route(companyId));
    } catch (e) {
      if (card.isConnected) card.append(node('p', e.message, 'notice'));
      return;
    }
    if (card.isConnected) paint(card, companyId, view);
  }

  function paint(card, companyId, view) {
    card.querySelector('form')?.remove();
    for (const old of card.querySelectorAll('p')) old.remove();
    card.append(
      node(
        'p',
        `Choose how many days each kind of record is kept, from ${view.min_days} to ${view.max_days}. Each starts at ${view.default_days}. Deleted records cannot be restored. Signed agreements and their photos are never deleted.`,
      ),
      node('p', runLine(view), 'hint'),
    );
    // Not .dashboard-form: that names the company-details form on this page.
    const form = node('form', undefined, 'retention-form');
    const inputs = {};
    for (const name of ORDER) {
      const label = node('label', LABELS[name] + ' (days)'),
        input = node('input'),
        effect = node('p', '', 'hint');
      input.type = 'number';
      input.name = name;
      input.min = String(view.min_days);
      input.max = String(view.max_days);
      input.step = '1';
      input.inputMode = 'numeric';
      input.required = true;
      input.value = String(view.days[name]);
      effect.id = 'retentionEffect-' + name;
      effect.setAttribute('aria-live', 'polite');
      input.setAttribute('aria-describedby', effect.id);
      const update = () => {
        effect.textContent = sentence(view, name, input.value);
        // The hint names the allowed range; aria-invalid keeps screen readers in step with it.
        input.setAttribute('aria-invalid', input.checkValidity() ? 'false' : 'true');
      };
      input.addEventListener('input', update);
      update();
      label.append(input);
      form.append(label, effect);
      inputs[name] = input;
    }
    const status = node('p', '', 'hint');
    status.setAttribute('role', 'status');
    const save = node('button', 'Save record retention');
    save.type = 'submit';
    save.className = 'primary';
    form.append(node('p', 'Saving needs a connection.', 'hint'), save, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      try {
        const values = {};
        for (const name of ORDER) values[name] = inputs[name].value;
        const days = chosen(view, values);
        const sooner = shortened(view, days);
        if (
          sooner.length &&
          !confirm(
            'Shorter periods delete older records at the next daily run, and they cannot be restored: ' +
              sooner.map((name) => LABELS[name]).join(', ') +
              '. Save?',
          )
        )
          return;
        save.disabled = true;
        const saved = await jsonApi(route(companyId), 'PUT', {
          expected_version: view.version,
          days,
        });
        paint(card, companyId, saved);
        say('Record retention saved.', 'success');
      } catch (e) {
        status.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    });
    card.append(form);
  }

  /* Once per page load and company, an active member's app asks the server for the daily sweep.
     The server decides whether it is due; the answer changes nothing on this phone. */
  const asked = new Set();
  function ready() {
    const session = typeof state === 'undefined' ? null : state.session;
    if (!session?.retention_enabled || !session.role || !session.company_id) return;
    if (asked.has(session.company_id) || !navigator.onLine) return;
    asked.add(session.company_id);
    jsonApi(route(session.company_id) + '/run', 'POST', {}).catch(() =>
      asked.delete(session.company_id),
    );
  }

  root.Retention = { LABELS, sentence, chosen, shortened, runLine, section, ready };
})(typeof window === 'undefined' ? globalThis : window);
