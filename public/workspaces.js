/* Company dashboards. The backend remains the authority for every permission. */
window.WorkspaceUI = (() => {
  let viewEpoch = 0,
    coordination = null,
    mirroredAddress = null,
    refreshing = false,
    initialized = false,
    supportUrls = [];
  const POSITIONING_HEADLINE = 'Water & mold loss estimates, signed on site.',
    POSITIONING_LINE =
      'Walk the loss, talk and photograph as you go, and leave with a priced proposal, itemized claim, scope defense letter and photo log.';
  const SUPPORT_EYEBROW = 'READ-ONLY SUPPORT VIEW',
    SUPPORT_NOTE =
      'Read-only: jobs, drafts and signed documents cannot be changed here. Every view and support action is recorded in the audit log.';
  const enabled = () => !!state.session?.workspaces_enabled;
  const can = (cap) => !enabled() || state.session.capabilities?.includes(cap);
  const context = () =>
    [
      state.user?.uid,
      state.session?.company_id,
      state.session?.role,
      state.session?.membership_version,
    ].join(':');
  const roleName = (role) =>
    ({ owner: 'Owner', estimator: 'Estimator', office: 'Office staff' })[role] ||
    'No company access';
  // Display only: the server already decides access; this just names both hats on the Account menu.
  const accountRoleLabel = () => {
    const { role, superadmin } = state.session;
    if (!superadmin) return roleName(role);
    return role ? roleName(role) + ' · Superadmin' : 'Superadmin';
  };
  function formField(form, label, name, value = '', type = 'text') {
    const wrapper = node('label', label),
      input = node(type === 'textarea' ? 'textarea' : 'input');
    input.name = name;
    if (type !== 'textarea') input.type = type;
    input.value = value;
    input.maxLength = type === 'textarea' ? 1500 : 500;
    wrapper.append(input);
    form.append(wrapper);
    return input;
  }
  function selectField(form, label, name, choices, value) {
    const wrapper = node('label', label),
      select = node('select');
    select.name = name;
    for (const [key, title] of choices) {
      const option = node('option', title);
      option.value = key;
      select.append(option);
    }
    select.value = value;
    wrapper.append(select);
    form.append(wrapper);
    return select;
  }
  function submit(form, label, action) {
    const control = node('button', label, 'primary');
    control.type = 'submit';
    form.append(control);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      control.disabled = true;
      try {
        await action(new FormData(form));
      } catch (e) {
        say(e.message, 'error');
      } finally {
        control.disabled = false;
      }
    });
  }
  function defaultEyebrow() {
    return state.session.superadmin
      ? state.session.role
        ? 'LOSS ESTIMATES · PLATFORM & COMPANY'
        : 'LOSS ESTIMATES · PLATFORM ADMINISTRATION'
      : 'LOSS ESTIMATES · ' + roleName(state.session.role).toUpperCase();
  }
  function show(title, description = '', eyebrow) {
    ++viewEpoch;
    for (const url of supportUrls) URL.revokeObjectURL(url);
    supportUrls = [];
    document.body.classList.add('dashboard-open');
    // Only the support view labels itself; leaving it restores the role's label.
    if (eyebrow) $('dashboardEyebrow').textContent = eyebrow;
    else if ($('dashboardEyebrow').textContent === SUPPORT_EYEBROW)
      $('dashboardEyebrow').textContent = defaultEyebrow();
    $('workspaceDashboard').hidden = false;
    $('dashboardHeading').textContent = title;
    $('dashboardDescription').textContent = description;
    $('dashboardContent').replaceChildren();
    $('jobCoordination').hidden = true;
    $('dashboardNewJob').hidden = true;
    return viewEpoch;
  }
  // Phones collapse the destinations behind #workspaceMenuToggle; CSS reads aria-expanded.
  function menu(open) {
    $('workspaceMenuToggle').setAttribute('aria-expanded', String(open));
  }
  function current(id) {
    for (const control of $('workspaceLinks').querySelectorAll('button'))
      if (control.id === id) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
  }
  // Phones fold the coordination form away while a job is worked; wider screens always show it.
  function fold(open) {
    $('coordinationToggle').setAttribute('aria-expanded', String(open));
    $('jobCoordination').classList.toggle('collapsed', !open);
  }
  function policy() {
    if (!enabled()) return;
    const editable = can('scope') && !!state.draft && !state.signed && !confirmedAuthorization;
    $('inspectionFields').disabled = !editable;
    $('technicianTranscript').readOnly = !editable;
    for (const [id, cap] of [
      ['startWalk', 'live'],
      ['backToLive', 'live'],
      ['startNotes', 'scope'],
      ['recordNote', 'scope'],
      ['addTypedNote', 'scope'],
      ['takePhoto', 'photos'],
      ['uploadPhoto', 'photos'],
      ['finishAudit', 'audit'],
      ['saveDraft', 'scope'],
      ['fillScope', 'scope'],
      ['fillScopeProperty', 'scope'],
      ['authorizeJob', 'sign'],
      ['sendHomeownerLink', 'sign'],
    ]) {
      if (!can(cap)) $(id).disabled = true;
    }
    $('signingArea').hidden = !can('sign') || !!state.signed || !!confirmedAuthorization;
    for (const control of $('coordinationForm').querySelectorAll('input,select,textarea,button'))
      control.disabled =
        !navigator.onLine ||
        !can('coordination') ||
        (control.id === 'coordAddress' && coordination?.status === 'signed');
    for (const control of $('dashboardContent').querySelectorAll(
      'form input,form select,form textarea,form button',
    ))
      control.disabled = !navigator.onLine;
    $('newInspection').disabled = !can('jobs_create');
    document.body.classList.toggle('office-view', state.session.role === 'office');
  }
  function branding() {
    if (!enabled()) return;
    const company = state.session.company,
      profile = company?.profile;
    const image = document.querySelector('.masthead .brand img'),
      title = document.querySelector('.masthead .brand strong');
    title.textContent = profile?.name || 'Company administration';
    document.body.classList.add('company-brand');
    const logo = ADRDocuments.logoFor(profile && { ...profile, company_id: company.company_id });
    image.hidden = !logo;
    if (logo) image.src = logo;
    else image.removeAttribute('src');
    image.alt = profile?.name || '';
    document.querySelector('.masthead .brand').setAttribute('aria-label', title.textContent);
    const menu = $('accountMenu').querySelector('.menu-content');
    if (!menu.querySelector('#workspaceAccountDetails')) {
      const start = menu.querySelector('hr');
      let sibling = start?.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        sibling.remove();
        sibling = next;
      }
      const details = node('div');
      details.id = 'workspaceAccountDetails';
      menu.append(details);
    }
    const details = $('workspaceAccountDetails');
    details.replaceChildren(
      node('strong', profile?.name || 'Platform administration'),
      node('p', accountRoleLabel()),
    );
    if (profile)
      details.append(
        node(
          'p',
          [profile.address, profile.phone, profile.license ? 'CSLB #' + profile.license : '']
            .filter(Boolean)
            .join(' · '),
        ),
      );
    $('footerText').textContent =
      (profile?.name || 'Restoration Field Estimator') + ' · Private company workspaces';
  }
  async function ready() {
    if (!enabled()) return;
    if (!initialized) {
      initialized = true;
      for (const [id, fn] of [
        ['dashboardHome', home],
        ['dashboardJobs', jobs],
        ['dashboardTeam', team],
        ['dashboardProfile', profile],
        ['dashboardAdmin', companies],
      ])
        $(id).addEventListener('click', () => {
          menu(false);
          fn().catch((e) => say(e.message, 'error'));
        });
      $('workspaceMenuToggle').addEventListener('click', () =>
        menu($('workspaceMenuToggle').getAttribute('aria-expanded') !== 'true'),
      );
      document.addEventListener('click', (event) => {
        if (!$('workspaceNav').contains(event.target)) menu(false);
      });
      $('workspaceNav').addEventListener('keydown', (event) => {
        const toggle = $('workspaceMenuToggle');
        if (event.key !== 'Escape' || toggle.getAttribute('aria-expanded') !== 'true') return;
        menu(false);
        toggle.focus();
      });
      $('coordinationToggle').addEventListener('click', () =>
        fold($('coordinationToggle').getAttribute('aria-expanded') !== 'true'),
      );
      // The phone header's More menu opens the folded coordination form.
      $('moreCoordination').addEventListener('click', () => {
        closeMenus();
        fold(true);
        $('coordinationToggle').focus();
      });
      $('dashboardNewJob').addEventListener('click', () =>
        Promise.resolve(openNew()).catch((e) => say(e.message, 'error')),
      );
      $('coordinationForm').addEventListener('submit', (event) => {
        event.preventDefault();
        saveCoordination().catch((e) => say(e.message, 'error'));
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh().catch((e) => say(e.message, 'error'));
      });
      window.addEventListener('focus', () => refresh().catch((e) => say(e.message, 'error')));
      window.addEventListener('online', () => refresh().catch((e) => say(e.message, 'error')));
      setInterval(() => {
        if (!document.hidden && navigator.onLine) refresh().catch((e) => say(e.message, 'error'));
      }, 20000);
    }
    for (const control of $('workspaceNav').querySelectorAll('button'))
      control.disabled = !!state.workspaceInitializing;
    $('workspaceNav').hidden = false;
    $('dashboardJobs').hidden = !state.session.role;
    $('dashboardJobs').textContent =
      state.session.role === 'estimator' ? 'My jobs' : 'Company jobs';
    $('dashboardTeam').hidden = !can('team_manage');
    $('dashboardProfile').hidden = !can('profile_manage');
    $('dashboardAdmin').hidden = !state.session.superadmin;
    branding();
    policy();
  }
  async function refresh() {
    if (!enabled() || !state.user || !navigator.onLine || refreshing || state.workspaceInitializing)
      return;
    refreshing = true;
    const uid = state.user.uid,
      previous = context();
    try {
      const token = await state.user.getIdToken();
      const response = await fetch('/api/access', {
        cache: 'no-store',
        headers: { ...(await appCheckHeaders()), Authorization: 'Bearer ' + token },
      });
      if (!response.ok)
        throw Error('Could not refresh company access. Reconnect before continuing.');
      const access = await response.json();
      if (state.user?.uid !== uid) return;
      const next = [uid, access.company_id, access.role, access.membership_version].join(':');
      if (previous !== next) {
        state.queuePaused = true;
        clearTimeout(saveTimer);
        clearTimeout(state.queueRetry);
        await stopWalk({ drain: false });
        await persist();
        await syncChain.catch(() => {});
        for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
        state.photoUrls.clear();
        state.draft = null;
        state.record = null;
        state.signed = null;
        state.ack = null;
        confirmedAuthorization = null;
        invalidate();
        clearDisplayedInspection();
      }
      state.session = { ...state.session, ...access };
      state.queuePaused = !access.role;
      await ready();
      if (previous !== next) {
        say('Your company access changed. Local drafts are retained for authorized recovery.');
        await landing();
      }
    } finally {
      refreshing = false;
    }
  }
  async function home() {
    if (!enabled()) return;
    await stopWalk();
    await persist();
    const epoch = show(
      state.session.company?.profile.name || 'Welcome',
      POSITIONING_HEADLINE + ' ' + POSITIONING_LINE,
    );
    current('dashboardHome');
    $('dashboardEyebrow').textContent = defaultEyebrow();
    $('dashboardNewJob').hidden = !can('jobs_create');
    const content = $('dashboardContent'),
      grid = node('div', undefined, 'dashboard-grid');
    content.append(grid);
    if (state.session.role) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h2', state.session.role === 'estimator' ? 'My jobs' : 'Company jobs'),
        node('p', 'Open drafts, review documents and recover signed agreements.'),
      );
      const actions = node('div', undefined, 'actions');
      actions.append(button('Open jobs', jobs));
      card.append(actions);
      grid.append(card);
    }
    if (can('team_manage')) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h2', 'Your team'),
        node('p', 'Invite estimators and office staff, and manage their access.'),
        button('Manage team', team),
      );
      grid.append(card);
    }
    if (state.session.superadmin) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h2', 'Companies'),
        node(
          'p',
          'Create workspaces, manage owners and open a read-only support view of any company.',
        ),
        button('Manage companies', companies),
      );
      grid.append(card);
    }
    const invitationId = new URL(location.href).searchParams.get('invite');
    let invitations = state.session.invitations || [];
    if (
      invitationId &&
      /^[a-f0-9]{32}$/.test(invitationId) &&
      !invitations.some((i) => i.invitation_id === invitationId)
    )
      invitations = [{ invitation_id: invitationId }, ...invitations];
    for (const entry of invitations) {
      try {
        const invite = await jsonApi('/api/invitations/' + entry.invitation_id);
        if (epoch !== viewEpoch) return;
        const card = node('section', undefined, 'dashboard-card');
        card.append(
          node('h2', 'Join ' + invite.company_name),
          node('p', 'Invited as ' + roleName(invite.role) + ' · ' + invite.email),
        );
        if (invite.status === 'pending' && invite.expires_at * 1000 > Date.now())
          card.append(
            button('Accept invitation', async () => {
              await jsonApi('/api/invitations/' + invite.invitation_id + '/accept', 'POST', {});
              const url = new URL(location.href);
              url.searchParams.delete('invite');
              history.replaceState(null, '', url);
              const token = await state.user.getIdToken();
              const response = await fetch('/api/session', {
                cache: 'no-store',
                headers: { ...(await appCheckHeaders()), Authorization: 'Bearer ' + token },
              });
              if (!response.ok) throw Error('Invitation accepted. Reload to refresh access.');
              state.session = await response.json();
              state.queuePaused = false;
              await ready();
              await landing();
              say('Company invitation accepted.', 'success');
            }),
          );
        else
          card.append(
            node(
              'p',
              'This invitation is ' + invite.status + '. Ask for a new invitation if needed.',
            ),
          );
        grid.append(card);
      } catch (e) {
        if (epoch === viewEpoch) say(e.message, 'error');
      }
    }
    if (!state.session.role && !state.session.superadmin && !invitations.length)
      content.append(node('p', 'Ask your company owner to invite this account’s email address.'));
  }
  async function landing() {
    if (['estimator', 'office'].includes(state.session?.role)) await jobs();
    else await home();
  }
  async function jobs() {
    await stopWalk();
    await persist();
    const epoch = show(
      state.session.role === 'estimator' ? 'My jobs' : 'Company jobs',
      'Draft inspections and saved agreements.',
    );
    current('dashboardJobs');
    $('dashboardNewJob').hidden = !can('jobs_create');
    const content = $('dashboardContent');
    const list = node('div', undefined, 'dashboard-list');
    content.append(list);
    const seen = new Set();
    const append = (records, signed) => {
      for (const record of records) {
        if (!signed && record.status === 'signed') continue;
        const id = signed ? record.auth_id : record.inspection_id;
        if (seen.has(id)) continue;
        seen.add(id);
        list.append(
          Object.assign(
            button(
              (record.address || 'Untitled job') +
                '\n' +
                (signed
                  ? 'Signed · ' + estimateLabel(record)
                  : 'Draft · revision ' + record.revision),
              () => (signed ? restoreSigned(id) : restoreDraft(id)),
            ),
            { className: 'job-link' },
          ),
        );
      }
    };
    const load = async (path, key, signed, cursor) => {
      const result = await jsonApi(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      if (epoch !== viewEpoch) return;
      append(result[key], signed);
      if (result.next_cursor) {
        const more = button('Load older ' + (signed ? 'agreements' : 'drafts'), async () => {
          more.disabled = true;
          try {
            await load(path, key, signed, result.next_cursor);
            more.remove();
          } catch (e) {
            more.disabled = false;
            throw e;
          }
        });
        list.append(more);
      }
    };
    if (navigator.onLine) {
      await load('/api/inspections', 'inspections', false);
      await load('/api/authorizations', 'authorizations', true);
    }
    if (epoch !== viewEpoch) return;
    if (can('scope'))
      for (const row of await localDrafts())
        if (!seen.has(row.draft.inspection_id) && row.record?.status !== 'signed')
          list.append(
            Object.assign(
              button((row.draft.data.address || 'Local draft') + '\nSaved on this device', () =>
                restoreDraft(row.draft.inspection_id),
              ),
              { className: 'job-link' },
            ),
          );
    if (!list.childElementCount) list.append(node('p', 'No jobs saved yet.'));
  }
  function invitationList(container, invitations, companyId, after, actions = true) {
    const list = node('div', undefined, 'dashboard-list');
    container.append(list);
    if (!invitations.length) list.append(node('p', 'No invitations yet.'));
    for (const invite of invitations) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h3', invite.email),
        node(
          'p',
          roleName(invite.role) + ' · ' + invite.status + ' · Email ' + invite.delivery_status,
        ),
      );
      if (invite.delivery_error) card.append(node('p', invite.delivery_error));
      if (actions && invite.status === 'pending')
        for (const action of ['resend', 'cancel'])
          card.append(
            button(action === 'resend' ? 'Resend invitation' : 'Cancel invitation', async () => {
              const result = await jsonApi(
                '/api/companies/' +
                  companyId +
                  '/invitations/' +
                  invite.invitation_id +
                  '/' +
                  action,
                'POST',
                {},
              );
              say(
                result.delivery_status === 'failed' ? result.delivery_error : 'Invitation updated.',
                result.delivery_status === 'failed' ? 'error' : 'success',
              );
              await (after
                ? after()
                : state.session.role === 'owner' && companyId === state.session.company_id
                  ? team()
                  : companyAdmin(companyId));
            }),
          );
      list.append(card);
    }
  }
  function inviteForm(container, companyId, owner = false) {
    const form = node('form', undefined, 'dashboard-form');
    form.append(node('h2', owner ? 'Invite / replace owner' : 'Invite staff'));
    const email = formField(form, 'Staff email', 'email', '', 'email');
    email.required = true;
    const select = selectField(
      form,
      'Role',
      'role',
      owner
        ? [['owner', 'Owner']]
        : [
            ['estimator', 'Estimator'],
            ['office', 'Office staff'],
          ],
      owner ? 'owner' : 'estimator',
    );
    if (owner)
      form.append(
        node(
          'p',
          'The current owner keeps access until the replacement accepts. Acceptance disables the former owner’s company membership.',
        ),
      );
    submit(form, 'Send invitation', async (values) => {
      const invite = await jsonApi('/api/companies/' + companyId + '/invitations', 'POST', {
        email: values.get('email'),
        role: values.get('role'),
      });
      say(
        invite.delivery_status === 'sent'
          ? 'Invitation email sent.'
          : invite.delivery_error || 'Invitation delivery is pending.',
        invite.delivery_status === 'failed' ? 'error' : 'success',
      );
      await (owner ? companyAdmin(companyId) : team());
    });
    container.append(form);
  }
  function temporaryPassword(form) {
    const input = formField(form, 'Temporary password', 'password', '', 'password');
    Object.assign(input, {
      required: true,
      minLength: 12,
      maxLength: 128,
      autocomplete: 'new-password',
      spellcheck: false,
      autocapitalize: 'off',
    });
    // Hidden while typed; Show lets the superadmin check it before creating the login.
    const show = node('button', 'Show');
    show.type = 'button';
    show.setAttribute('aria-pressed', 'false');
    show.addEventListener('click', () => {
      const shown = input.type === 'password';
      input.type = shown ? 'text' : 'password';
      show.textContent = shown ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(shown));
    });
    const row = node('div', undefined, 'temporary-password');
    row.append(input.closest('label'), show, node('p', 'At least 12 characters.', 'hint'));
    form.append(row);
    return input;
  }
  // The password exists only here and in the superadmin's own email; the server never returns it.
  function loginCreated(email, password) {
    const card = node('section', undefined, 'dashboard-card login-created'),
      code = node('code', password);
    card.setAttribute('role', 'status');
    card.append(
      node('h2', 'Owner login created'),
      node(
        'p',
        'Send this sign-in to the owner from your own email. DryScope sends nothing and shows this password only now. At first sign-in the owner sets their own password.',
      ),
      node('p', 'Email: ' + email),
      node('p', 'Temporary password: '),
      button('Copy password', async () => {
        try {
          await navigator.clipboard.writeText(password);
          say('Password copied.', 'success');
        } catch {
          getSelection().selectAllChildren(code);
          say('Copying is blocked here. The password is selected; copy it yourself.', 'error');
        }
      }),
    );
    card.children[3].append(code);
    $('dashboardContent').prepend(card);
  }
  // Only the account that submitted sees the credentials; if the sign-in changed meanwhile, nothing shows.
  // The refresh replaces this view; the credentials show whether or not it succeeds.
  async function ownerLoginCreated(signedIn, cid, result, password, message) {
    if (signInMark() !== signedIn) return;
    try {
      await companyAdmin(cid);
    } finally {
      if (signInMark() === signedIn) loginCreated(result.owner.email, password);
    }
    if (signInMark() === signedIn) say(message, 'success');
  }
  function ownerLoginForm(container, company) {
    const cid = company.company_id,
      form = node('form', undefined, 'dashboard-form');
    form.append(
      node('h2', 'Create login with temporary password'),
      node(
        'p',
        (company.owner_uid
          ? 'Replaces the current owner now and disables their company access. '
          : 'Makes this login the owner now and cancels pending owner invitations. ') +
          'No email is sent: you send the email address and password yourself.',
      ),
    );
    formField(form, 'Owner’s email', 'email', '', 'email').required = true;
    temporaryPassword(form);
    submit(form, 'Create login', async (values) => {
      const signedIn = signInMark(),
        result = await jsonApi('/api/admin/companies/' + cid + '/owner-login', 'POST', {
          email: values.get('email'),
          password: values.get('password'),
          expected_version: company.version,
        });
      await ownerLoginCreated(
        signedIn,
        cid,
        result,
        values.get('password'),
        'Owner login created.',
      );
    });
    container.append(form);
  }
  async function team() {
    const cid = state.session.company_id,
      epoch = show('Team & invitations', 'Add staff and manage their company access.');
    current('dashboardTeam');
    const [teamData, invites] = await Promise.all([
      jsonApi('/api/companies/' + cid + '/team'),
      jsonApi('/api/companies/' + cid + '/invitations'),
    ]);
    if (epoch !== viewEpoch) return;
    const content = $('dashboardContent');
    inviteForm(content, cid);
    const grid = node('div', undefined, 'dashboard-grid');
    content.append(grid);
    for (const member of teamData.members) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h3', member.email),
        node('p', roleName(member.role) + ' · ' + member.status),
      );
      if (member.role !== 'owner' || member.status !== 'active') {
        const form = node('form');
        selectField(
          form,
          'Role',
          'role',
          [
            ['estimator', 'Estimator'],
            ['office', 'Office staff'],
          ],
          member.role === 'owner' ? 'estimator' : member.role,
        );
        selectField(
          form,
          'Access',
          'status',
          [
            ['active', 'Active'],
            ['disabled', 'Disabled'],
          ],
          member.status,
        );
        submit(form, 'Save access', async (values) => {
          await jsonApi('/api/companies/' + cid + '/team/' + member.uid, 'PUT', {
            expected_version: member.version,
            role: values.get('role'),
            status: values.get('status'),
          });
          await team();
          say('Staff access updated.', 'success');
        });
        card.append(form);
      }
      grid.append(card);
    }
    content.append(node('h2', 'Invitations'));
    invitationList(content, invites.invitations, cid);
  }
  async function profile() {
    const cid = state.session.company_id,
      epoch = show(
        'Company settings',
        'These details appear on new proposals. Changes require unsigned documents to be regenerated.',
      );
    current('dashboardProfile');
    const company = await jsonApi('/api/companies/' + cid);
    if (epoch !== viewEpoch) return;
    const form = node('form', undefined, 'dashboard-form'),
      p = company.profile;
    for (const [key, label] of [
      ['name', 'Company name'],
      ['address', 'Company address'],
      ['phone', 'Phone'],
      ['email', 'Contact email'],
      ['license', 'CSLB license'],
      ['signoff', 'Document sign-off'],
    ])
      formField(form, label, key, p[key] || '', key === 'email' ? 'email' : 'text').required = [
        'name',
        'address',
        'license',
        'signoff',
      ].includes(key);
    const logo = formField(form, 'Optional logo (PNG or JPEG, up to 1 MB)', 'logo', '', 'file');
    logo.accept = 'image/png,image/jpeg';
    submit(form, 'Save company details', async (values) => {
      const updated = { ...p };
      for (const key of ['name', 'address', 'phone', 'email', 'license', 'signoff'])
        if (values.has(key)) updated[key] = values.get(key);
      if (logo.files[0]) {
        if (logo.files[0].size > 1000000) throw Error('Logo exceeds 1 MB.');
        updated.logo_data_url = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(Error('Logo could not be read.'));
          reader.readAsDataURL(logo.files[0]);
        });
      }
      state.session.company = await jsonApi('/api/companies/' + cid, 'PUT', {
        expected_version: company.version,
        profile: updated,
      });
      branding();
      await profile();
      say('Company details saved. Regenerate unsigned documents before signing.', 'success');
    });
    $('dashboardContent').append(form);
  }
  async function companies() {
    const epoch = show('Companies', 'Manage isolated company workspaces and their owners.');
    current('dashboardAdmin');
    const result = await jsonApi('/api/admin/companies');
    if (epoch !== viewEpoch) return;
    const content = $('dashboardContent'),
      form = node('form', undefined, 'dashboard-form');
    form.append(node('h2', 'Create a company'));
    formField(form, 'Company name', 'name').required = true;
    formField(form, 'Owner’s email', 'owner_email', '', 'email').required = true;
    const method = selectField(
        form,
        'Owner sign-in',
        'owner_signin',
        [
          ['invite', 'Email an invitation'],
          ['password', 'Create login with temporary password'],
        ],
        'invite',
      ),
      password = temporaryPassword(form);
    const choose = () => {
      const direct = method.value === 'password';
      password.closest('.temporary-password').hidden = !direct;
      password.required = direct;
      if (!direct) password.value = '';
      control.textContent = direct ? 'Create company & owner login' : 'Create & invite owner';
    };
    submit(form, 'Create & invite owner', async (values) => {
      if (values.get('owner_signin') === 'password') {
        const signedIn = signInMark(),
          result = await jsonApi('/api/admin/companies', 'POST', {
            name: values.get('name'),
            owner_email: values.get('owner_email'),
            owner_password: values.get('password'),
          });
        await ownerLoginCreated(
          signedIn,
          result.company.company_id,
          result,
          values.get('password'),
          'Company created with an owner login.',
        );
        return;
      }
      const result = await jsonApi('/api/admin/companies', 'POST', {
        name: values.get('name'),
        owner_email: values.get('owner_email'),
      });
      await companyAdmin(result.company.company_id);
      say(
        result.invitation.delivery_status === 'sent'
          ? 'Company created and owner invitation sent.'
          : result.invitation.delivery_error || 'Company created; email pending.',
        result.invitation.delivery_status === 'failed' ? 'error' : 'success',
      );
    });
    const control = form.querySelector('button[type=submit]');
    method.addEventListener('change', choose);
    choose();
    content.append(form);
    const grid = node('div', undefined, 'dashboard-grid');
    content.append(grid);
    for (const company of result.companies) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h2', company.profile.name),
        node(
          'p',
          company.status +
            ' · ' +
            (company.owner_uid ? 'Owner assigned' : 'Owner invitation pending'),
        ),
        button('Manage company', () => companyAdmin(company.company_id)),
      );
      grid.append(card);
    }
  }
  async function companyAdmin(cid) {
    const epoch = show('Company administration', 'Manage ownership and workspace availability.');
    const [company, invites] = await Promise.all([
      jsonApi('/api/companies/' + cid),
      jsonApi('/api/companies/' + cid + '/invitations'),
    ]);
    if (epoch !== viewEpoch) return;
    $('dashboardHeading').textContent = company.profile.name;
    const content = $('dashboardContent');
    content.append(
      node('p', 'Company status: ' + company.status),
      button('Open read-only support view', () => support(cid)),
      button(company.status === 'active' ? 'Suspend company' : 'Reactivate company', async () => {
        await jsonApi('/api/admin/companies/' + cid + '/status', 'PUT', {
          expected_version: company.version,
          status: company.status === 'active' ? 'suspended' : 'active',
        });
        await refresh();
        await companyAdmin(cid);
      }),
    );
    if (company.status === 'active') {
      inviteForm(content, cid, true);
      ownerLoginForm(content, company);
    }
    content.append(node('h2', 'Invitations'));
    invitationList(content, invites.invitations, cid);
  }
  const supportBase = (cid) => '/api/admin/companies/' + encodeURIComponent(cid);
  function supportImage(path, alt) {
    const image = node('img', undefined, 'support-image'),
      epoch = viewEpoch;
    image.alt = alt;
    api(path)
      .then((response) => response.blob())
      .then((blob) => {
        if (epoch !== viewEpoch) return;
        image.src = URL.createObjectURL(blob);
        supportUrls.push(image.src);
      })
      .catch(() => image.replaceWith(node('p', alt + ' could not be loaded.')));
    return image;
  }
  // Superadmin support: the server allows reads plus a few audited team fixes, nothing else.
  async function support(cid) {
    const epoch = show('Support view', SUPPORT_NOTE, SUPPORT_EYEBROW);
    const base = supportBase(cid);
    const [company, drafts, signed, teamData, invites] = await Promise.all([
      jsonApi('/api/companies/' + cid),
      jsonApi(base + '/jobs'),
      jsonApi(base + '/authorizations'),
      jsonApi('/api/companies/' + cid + '/team'),
      jsonApi('/api/companies/' + cid + '/invitations'),
    ]);
    if (epoch !== viewEpoch) return;
    $('dashboardHeading').textContent = 'Support · ' + company.profile.name;
    const content = $('dashboardContent'),
      active = company.status === 'active';
    content.append(
      node('p', SUPPORT_NOTE, 'support-note'),
      node('p', 'Company status: ' + company.status),
      button('Back to company administration', () => companyAdmin(cid)),
      node('h2', 'Jobs and documents'),
    );
    const list = node('div', undefined, 'dashboard-list');
    content.append(list);
    // Signed jobs are listed once, as their agreements.
    for (const record of drafts.inspections.filter((r) => r.status !== 'signed'))
      list.append(
        Object.assign(
          button((record.address || 'Untitled job') + '\nDraft · revision ' + record.revision, () =>
            supportRecord(cid, record.inspection_id, false),
          ),
          { className: 'job-link' },
        ),
      );
    for (const record of signed.authorizations)
      list.append(
        Object.assign(
          button(
            (record.address || 'Untitled job') + '\nSigned agreement · ' + estimateLabel(record),
            () => supportRecord(cid, record.auth_id, true),
          ),
          { className: 'job-link' },
        ),
      );
    if (!list.childElementCount) list.append(node('p', 'No jobs saved yet.'));
    if (drafts.next_cursor || signed.next_cursor)
      list.append(node('p', 'Showing the 100 most recent drafts and agreements.'));
    content.append(node('h2', 'Team'));
    const grid = node('div', undefined, 'dashboard-grid');
    content.append(grid);
    const change = (member, role, status, message) =>
      button(message, async () => {
        await jsonApi('/api/companies/' + cid + '/team/' + member.uid, 'PUT', {
          expected_version: member.version,
          role,
          status,
        });
        await support(cid);
        say('Staff access updated. The change is recorded in the audit log.', 'success');
      });
    for (const member of teamData.members) {
      const card = node('section', undefined, 'dashboard-card');
      card.append(
        node('h3', member.email),
        node('p', roleName(member.role) + ' · ' + member.status),
      );
      // Owners change only through owner invitations; support never edits its own membership.
      if (active && member.role !== 'owner' && member.uid !== state.user?.uid) {
        const actions = node('div', undefined, 'actions'),
          other = member.role === 'estimator' ? 'office' : 'estimator';
        actions.append(
          change(member, other, member.status, 'Change to ' + roleName(other).toLowerCase()),
        );
        if (member.status === 'disabled')
          actions.append(change(member, member.role, 'active', 'Re-enable access'));
        card.append(actions);
      }
      grid.append(card);
    }
    if (!teamData.members.length) grid.append(node('p', 'No team members yet.'));
    content.append(node('h2', 'Invitations'));
    invitationList(content, invites.invitations, cid, () => support(cid), active);
  }
  async function supportRecord(cid, id, signed) {
    const epoch = show(signed ? 'Signed agreement' : 'Job details', SUPPORT_NOTE, SUPPORT_EYEBROW);
    const base =
      supportBase(cid) + (signed ? '/authorizations/' : '/jobs/') + encodeURIComponent(id);
    const result = await jsonApi(base);
    if (epoch !== viewEpoch) return;
    const record = signed ? result.authorization : result.inspection,
      job = result.job,
      scope = (signed ? record.inspection : record.data) || {},
      docs = signed ? record.documents : record.audit?.documents,
      content = $('dashboardContent');
    content.append(
      node('p', SUPPORT_NOTE, 'support-note'),
      button('Back to support view', () => support(cid)),
    );
    const facts = node('section', undefined, 'dashboard-card');
    facts.append(node('h2', record.address || scope.address || 'Untitled job'));
    for (const line of [
      signed
        ? 'Signed ' + new Date(record.created_at).toLocaleString()
        : 'Status: ' + record.status + ' · revision ' + record.revision,
      'Year built: ' + (scope.year_built || 'not entered'),
      'Assigned estimator: ' + (job.assigned_estimator_uid || 'unassigned'),
      [job.customer_name, job.customer_phone, job.customer_email].filter(Boolean).join(' · '),
      job.office_notes ? 'Office notes: ' + job.office_notes : '',
    ])
      if (line) facts.append(node('p', line));
    if (record.signer) facts.append(node('p', 'Signed through the homeowner link'));
    content.append(facts);
    const rooms = node('section', undefined, 'dashboard-card');
    rooms.append(node('h2', 'Rooms'));
    for (const room of scope.rooms || [])
      rooms.append(
        node(
          'p',
          room.name +
            ' · Category ' +
            room.category +
            ' · ' +
            room.finished_sf +
            ' finished SF · ' +
            room.unfinished_sf +
            ' unfinished SF',
        ),
      );
    if (!scope.rooms?.length) rooms.append(node('p', 'No rooms entered.'));
    content.append(rooms);
    const documents = node('section', undefined, 'dashboard-card');
    documents.append(node('h2', 'Documents'));
    if (docs) {
      documents.append(
        node('p', 'Customer estimate range: ' + estimateLabel(docs.adr_estimate), 'money'),
        node('p', 'Itemized charges at base rates: ' + ADRCore.money(docs.xactimate_total)),
        node('h3', 'Findings'),
      );
      for (const text of docs.adr_estimate.findings || []) documents.append(node('p', text));
      documents.append(node('h3', 'Line items'));
      for (const item of docs.xactimate_scope || [])
        documents.append(
          node(
            'p',
            item.code +
              ' · ' +
              (item.description || item.desc) +
              ' · ' +
              (item.quantity ?? item.qty) +
              ' ' +
              item.unit +
              ' · ' +
              ADRCore.money(item.total),
          ),
        );
    } else documents.append(node('p', 'No documents generated for this revision.'));
    content.append(documents);
    const photos = node('section', undefined, 'dashboard-card');
    photos.append(node('h2', 'Photos'));
    (record.photos || []).forEach((photo, i) => {
      photos.append(
        supportImage(
          base + (signed ? '/evidence/photo-' + i : '/photos/' + encodeURIComponent(photo.id)),
          (photo.room || 'Job') + ' photo',
        ),
        node(
          'p',
          'Photo ' +
            (i + 1) +
            ' (' +
            (photo.room || 'Historical evidence') +
            ') · ' +
            (photo.ocr_status === 'verified'
              ? 'Verified meter: ' + photo.ocr.value
              : 'Unverified: ' + String(photo.ocr_status || 'unknown').replaceAll('_', ' ')),
        ),
      );
    });
    if (!record.photos?.length) photos.append(node('p', 'No photos attached.'));
    content.append(photos);
    if (signed) {
      const signature = node('section', undefined, 'dashboard-card');
      signature.append(
        node('h2', 'Signature'),
        supportImage(base + '/evidence/signature', 'Customer signature'),
      );
      content.append(signature);
    }
  }
  async function editor() {
    if (!enabled()) return;
    ++viewEpoch;
    document.body.classList.remove('dashboard-open');
    $('workspaceDashboard').hidden = true;
    current(null);
    fold(false);
    policy();
    await loadCoordination();
  }
  async function loadCoordination() {
    coordination = null;
    $('jobCoordination').hidden = true;
    if (!enabled() || !can('coordination') || !state.draft?.inspection_id || !navigator.onLine)
      return;
    const id = state.draft.inspection_id,
      key = context();
    const [job, directory] = await Promise.all([
      jsonApi('/api/jobs/' + id + '/coordination'),
      jsonApi('/api/companies/' + state.session.company_id + '/team'),
    ]);
    if (id !== state.draft?.inspection_id || key !== context()) return;
    coordination = job;
    mirroredAddress = job.address;
    $('coordAddress').value = job.address;
    $('coordAddress').disabled = job.status === 'signed';
    $('coordName').value = job.customer_name;
    $('coordPhone').value = job.customer_phone;
    $('coordEmail').value = job.customer_email;
    $('coordNotes').value = job.office_notes;
    $('coordEstimator').replaceChildren();
    const empty = node('option', 'Unassigned');
    empty.value = '';
    $('coordEstimator').append(empty);
    for (const member of directory.members.filter(
      (m) => m.role === 'estimator' && m.status === 'active',
    )) {
      const option = node('option', member.email);
      option.value = member.uid;
      $('coordEstimator').append(option);
    }
    scopeAddressChanged();
    $('coordEstimator').value = job.assigned_estimator_uid || '';
    $('jobCoordination').hidden = false;
    $('saveCoordination').disabled = false;
    $('coordinationStatus').textContent = '';
  }
  function scopeAddressChanged() {
    if (
      !coordination ||
      !can('scope') ||
      state.signed ||
      !state.draft ||
      coordination.job_id !== state.draft.inspection_id
    )
      return;
    if ($('coordAddress').value === mirroredAddress) {
      mirroredAddress = state.draft.data.address;
      $('coordAddress').value = mirroredAddress;
    }
  }
  async function saveCoordination() {
    if (!coordination || !$('coordinationForm').reportValidity()) return;
    $('saveCoordination').disabled = true;
    try {
      if (can('scope')) await syncDraft();
      const id = state.draft.inspection_id;
      coordination = await jsonApi('/api/jobs/' + id + '/coordination', 'PUT', {
        expected_version: coordination.version,
        address: $('coordAddress').value,
        assigned_estimator_uid: $('coordEstimator').value || null,
        customer_name: $('coordName').value,
        customer_phone: $('coordPhone').value,
        customer_email: $('coordEmail').value,
        office_notes: $('coordNotes').value,
      });
      mirroredAddress = coordination.address;
      if (!state.signed) {
        const record = await jsonApi('/api/inspections/' + id);
        state.draft.data = record.data;
        state.ack = stable(record.data);
        absorb(record);
        fillForm();
        policy();
        await persist();
      }
      $('coordinationStatus').textContent = 'Coordination saved.';
    } finally {
      $('saveCoordination').disabled = false;
      policy();
    }
  }
  function documentBranding() {
    if (!state.documents) return;
    ADRDocuments.brand(state.documents, state.session?.legacy_identity);
    policy();
  }
  return {
    enabled,
    can,
    context,
    ready,
    home,
    landing,
    jobs,
    editor,
    policy,
    refresh,
    documentBranding,
    scopeAddressChanged,
  };
})();
