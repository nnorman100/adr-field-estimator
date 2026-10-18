/* Small pure functions shared by the UI and behavioral tests. */
(function (root) {
  const emptyData = () => ({
    address: '',
    year_built: null,
    // Retired flags the server still accepts and returns for older drafts.
    has_crawl_space: false,
    granite_removal: false,
    water_heater_loss: false,
    work_performed: false,
    rooms: [
      {
        name: 'Room 1',
        category: 1,
        loss: 'water',
        unfinished_sf: 0,
        finished_sf: 0,
        custom_cabinetry: false,
        waste_percent: 0,
      },
    ],
    air_movers: 0,
    dehumidifiers: 0,
    drying_days: 3,
    labor_hours: 0,
    is_after_hours: false,
    emergency_calls: 1,
    monitoring_hours: 13.25,
    haul_loads: 1,
    air_scrubbers: 1,
    hepa_filters: 1,
    matterport_scans: 0,
    dump_truck_loads: 0,
    equipment_decon: 0,
    power_distribution: 0,
    wood_floor_systems: 0,
    wood_floor_days: 7,
    package_price: null,
    technician_notes: '',
    technician_transcript: '',
    assistant_transcript: '',
    scope_confirmed: false,
  });
  const stable = (value) =>
    JSON.stringify(value, (_, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v)
            .sort()
            .reduce((o, k) => ((o[k] = v[k]), o), {})
        : v,
    );
  const money = (value) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
  const estimateLabel = (proposal) =>
    proposal.proposed_cost_low == null
      ? money(proposal.proposed_cost)
      : money(proposal.proposed_cost_low) + '–' + money(proposal.proposed_cost);
  const pcmToFloat = (bytes) => {
    if (bytes.byteLength % 2) throw Error('Invalid PCM');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float32Array.from(
      { length: bytes.byteLength / 2 },
      (_, i) => view.getInt16(i * 2, true) / 32768,
    );
  };
  const aspect = (width, height, limit = 1280) => {
    const scale = Math.min(1, limit / Math.max(width, height));
    return [Math.round(width * scale), Math.round(height * scale)];
  };
  const scopeJobLabels = {
    address: 'Property address',
    year_built: 'Year built',
    air_movers: 'Air movers',
    dehumidifiers: 'LGR dehumidifiers',
    drying_days: 'Drying days',
    labor_hours: 'Additional labor hours',
    is_after_hours: 'After-hours loss',
    emergency_calls: 'Emergency calls',
    monitoring_hours: 'Monitoring hours',
    haul_loads: 'Haul pickup loads',
    air_scrubbers: 'Air-scrubber rental days',
    hepa_filters: 'HEPA filters',
    matterport_scans: 'Matterport scans',
    dump_truck_loads: 'Dump-truck loads',
    equipment_decon: 'Equipment decontamination',
    power_distribution: 'Power distribution units',
    wood_floor_systems: 'Wood-floor systems / heaters',
    wood_floor_days: 'Wood-floor drying days',
  };
  const scopeRoomLabels = {
    category: 'Water category',
    loss: 'Loss type',
    unfinished_sf: 'Unfinished / subfloor SF',
    finished_sf: 'Finished / drywall / trim SF',
    custom_cabinetry: 'Custom cabinetry',
    waste_percent: 'Waste %',
  };
  const roomKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const untouchedDefaultRoom = (room) =>
    room.name === 'Room 1' &&
    room.unfinished_sf === 0 &&
    room.finished_sf === 0 &&
    room.custom_cabinetry === false;
  function defaultRoomReplacement(data, changes) {
    if (data.rooms.length !== 1 || !untouchedDefaultRoom(data.rooms[0])) return null;
    if (changes.some((change) => change.room != null && roomKey(change.room) === 'room 1'))
      return null;
    return changes.find((change) => change.room != null)?.room || null;
  }
  // Only the initial placeholder transition (and its Undo) changes existing photo labels.
  function defaultPhotoRename(before, after) {
    const oldRooms = before.rooms,
      newRooms = after.rooms;
    if (!oldRooms.length || !newRooms.length || oldRooms[0].name === newRooms[0].name) return null;
    if (
      (oldRooms.length === 1 &&
        untouchedDefaultRoom(oldRooms[0]) &&
        !newRooms.some((room) => roomKey(room.name) === 'room 1')) ||
      (newRooms[0].name === 'Room 1' &&
        !oldRooms.some((room) => roomKey(room.name) === 'room 1') &&
        !newRooms.some((room) => roomKey(room.name) === roomKey(oldRooms[0].name)))
    )
      return { from: oldRooms[0].name, to: newRooms[0].name };
    return null;
  }
  // The loss type is a label chosen beside the category; pricing still reads the category. A room
  // saved before the label existed shows the tag it showed then: category 3 as mold, otherwise
  // water. The first category change on such a room keeps that tag as its loss type.
  function roomLoss(room) {
    return room.loss || (Number(room.category) === 3 ? 'mold' : 'water');
  }
  function applyScopeChanges(data, changes) {
    const result = structuredClone(data),
      newRooms = new Map(),
      replacement = defaultRoomReplacement(data, changes);
    for (const change of changes) {
      if (change.room == null) {
        if (!Object.hasOwn(scopeJobLabels, change.field)) throw Error('Unsupported scope field.');
        result[change.field] = change.value;
      } else {
        if (!Object.hasOwn(scopeRoomLabels, change.field)) throw Error('Unsupported room field.');
        const matches = result.rooms.filter((room) => roomKey(room.name) === roomKey(change.room));
        if (matches.length > 1)
          throw Error('Give duplicate rooms distinct names before applying changes.');
        let room = matches[0];
        if (!room) {
          const key = roomKey(change.room);
          if (!newRooms.has(key)) newRooms.set(key, { name: change.room });
          room = newRooms.get(key);
        } else if (change.field === 'category') room.loss = roomLoss(room);
        room[change.field] = change.value;
      }
    }
    for (const room of newRooms.values()) {
      if (
        !Object.hasOwn(room, 'category') ||
        (!Object.hasOwn(room, 'finished_sf') && !Object.hasOwn(room, 'unfinished_sf'))
      )
        throw Error('A new room needs a stated water category and demolition area.');
      const filled = {
        ...(room.name === replacement ? data.rooms[0] : emptyData().rooms[0]),
        ...room,
      };
      if (room.name === replacement) result.rooms[0] = filled;
      else result.rooms.push(filled);
    }
    if (result.rooms.length > 30) throw Error('At most 30 rooms are supported.');
    result.scope_confirmed = false;
    return result;
  }
  function ingestTranscript(data, message) {
    const capture = data.capture_metadata;
    if (!capture) return { changed: false };
    const identity = message.connection_id + ':' + message.sequence;
    if (
      capture.segments.some(
        (segment) => segment.connection_id + ':' + segment.sequence === identity,
      )
    )
      return { changed: false };
    const side = message.speaker === 'technician' ? 'technician' : 'assistant',
      key = side + '_transcript';
    const previous = [...capture.segments].reverse().find((segment) => segment.speaker === side);
    const boundary =
      message.text &&
      data[key] &&
      (!previous || previous.finished === true || previous.connection_id !== message.connection_id)
        ? '\n'
        : '';
    if (
      (data[key] || '').length + boundary.length + message.text.length > 80000 ||
      capture.segments.length >= 2000
    ) {
      capture.status = 'truncated';
      return { changed: true, limit: true };
    }
    const before = data[key] || '';
    capture.segments.push({
      speaker: side,
      connection_id: message.connection_id,
      sequence: message.sequence,
      text: message.text,
      finished: message.finished ?? null,
    });
    data[key] = before + boundary + message.text;
    if (new TextEncoder().encode(JSON.stringify(data)).length > 550000) {
      capture.segments.pop();
      data[key] = before;
      capture.status = 'truncated';
      return { changed: true, limit: true };
    }
    return { changed: true, preview: message.finished !== true };
  }
  // Vertex Live never sets a transcription's finished flag, so a completed or interrupted model
  // turn closes the speakers' open segments; each speaker's next text then starts a new line.
  function closeTranscript(data, connectionId, speakers) {
    const segments = data.capture_metadata?.segments || [];
    let closed = false;
    for (const speaker of speakers) {
      const last = [...segments].reverse().find((segment) => segment.speaker === speaker);
      if (last && last.connection_id === connectionId && last.finished !== true) {
        last.finished = true;
        closed = true;
      }
    }
    return closed;
  }
  const authStage = (user) =>
    !user
      ? 'signedOut'
      : !user.emailVerified &&
          (user.providerData || []).some((info) => info?.providerId === 'password')
        ? 'unverified'
        : 'ready';
  // One message for unknown email and wrong password so sign-in does not reveal which accounts exist.
  const credentialMessage = 'Email or password is incorrect.';
  const authMessages = {
    'auth/wrong-password': credentialMessage,
    'auth/user-not-found': credentialMessage,
    'auth/invalid-credential': credentialMessage,
    'auth/invalid-login-credentials': credentialMessage,
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/admin-restricted-operation': 'Ask your company owner for an invitation.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes, then try again.',
    'auth/network-request-failed': 'Network error. Check your connection and try again.',
    'auth/account-exists-with-different-credential':
      'This email already uses a different sign-in method. Use that method.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before it finished.',
  };
  // Unmapped Firebase codes stay visible so a failed sign-in can be diagnosed from a screenshot.
  const authMessage = (error) =>
    authMessages[error?.code] ||
    (/^auth\/[a-z0-9-]+$/.test(error?.code)
      ? 'Sign-in could not be completed (' + error.code + '). Try again.'
      : 'Sign-in could not be completed. Try again.');
  // Hosting serves the sign-in helper at /__/auth/ on every site. On the live web.app site the app
  // uses that same-origin copy, so Safari's third-party storage blocking cannot separate the Google
  // popup from the page. Elsewhere (preview channels, localhost) the configured authDomain stays,
  // because each handler URL must be an authorized redirect URI on the Google OAuth client.
  const authDomainFor = (config, host) =>
    host === config.projectId + '.web.app' ? host : config.authDomain;
  // A host with a trailing dot (web.app.) is a separate origin that Firebase Auth and the Live relay
  // refuse. Returns the same URL on the host without the dots, or null when the host is canonical.
  const canonicalUrl = (href) => {
    const url = new URL(href);
    if (!url.hostname.endsWith('.')) return null;
    url.hostname = url.hostname.replace(/\.+$/, '');
    return url.href;
  };
  // Draft rows are rewritten on every save; photo bytes are stored once beside them.
  const splitPhotos = (draft) => ({
    draft: { ...draft, photos: draft.photos.map(({ data_url, ...photo }) => photo) },
    bytes: draft.photos
      .filter((photo) => photo.data_url)
      .map((photo) => ({ id: photo.id, data_url: photo.data_url })),
  });
  // Gaps the technician can still fill on site, checked against the form with any proposed scope
  // values applied. The model's clarification questions are listed beside these.
  function missingItems(data, photos = []) {
    const items = [];
    if (!String(data.address || '').trim()) items.push('No property address');
    if (data.year_built == null) items.push('No year built');
    if (!data.rooms.length) items.push('No affected rooms');
    for (const room of data.rooms) {
      const name = room.name.trim() || 'Unnamed room';
      if (!(room.finished_sf > 0) && !(room.unfinished_sf > 0))
        items.push('No measured demolition area for ' + name);
      if (!photos.some((photo) => roomKey(photo.room) === roomKey(room.name)))
        items.push('No photo of ' + name);
    }
    if (!(data.air_movers > 0) && !(data.dehumidifiers > 0) && !(data.wood_floor_systems > 0))
      items.push('No drying equipment counts');
    return items;
  }
  // Why the audit blocks signing, built from the audit's own lists so it names only real causes.
  // Photos are numbered in photo-log order, as the documents cite them.
  function auditBlockMessage(docs, canManageProfile) {
    const setup = docs.company_setup_missing || [],
      unpriced = docs.unpriced_work || [],
      pending = (docs.photo_audit_log || []).flatMap((photo, i) =>
        photo.ocr_status === 'pending' ? ['Photo ' + (i + 1) + ' (' + photo.room + ')'] : [],
      ),
      list = (items) =>
        items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1),
      count = setup.length + unpriced.length + pending.length;
    if (!count)
      return "Can't sign yet: no measured demolition, drying equipment or labor is entered. Add the work on 2. Check Scope, then Finish & review again.";
    const lines = ["Can't sign yet: " + count + (count === 1 ? ' item' : ' items') + ' to fix.'];
    if (unpriced.length)
      lines.push(
        ...unpriced.map(
          (text) => 'Unpriced work: ' + text.trim() + (/[.!?]$/.test(text.trim()) ? '' : '.'),
        ),
        (unpriced.length === 1 ? 'Add it' : 'Add them') +
          ' on 2. Check Scope (Rooms & demolition or Equipment & additional labor), or tap Fill scope from walkthrough, then Finish & review again.',
      );
    if (setup.length)
      lines.push(
        'Company settings are missing the ' +
          list(setup) +
          (canManageProfile
            ? '. Complete them in Company settings, then Finish & review again.'
            : '. Ask your company owner to complete them in Company settings, then Finish & review again.'),
      );
    if (pending.length)
      lines.push(
        'Photo recognition is still running for ' +
          list(pending) +
          '. Wait a moment, then Finish & review again.',
      );
    return lines.join(' ');
  }
  // Voice-note formats in preference order: iPhone Safari and Home Screen apps record MP4 (AAC);
  // Chrome and Firefox record WebM or Ogg Opus. The upload type drops the codec parameter.
  const NOTE_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  function noteFormat(isSupported) {
    const type = NOTE_TYPES.find((candidate) => isSupported(candidate));
    return type ? { recorder: type, upload: type.split(';')[0] } : null;
  }
  const api = {
    emptyData,
    stable,
    money,
    estimateLabel,
    pcmToFloat,
    aspect,
    scopeJobLabels,
    scopeRoomLabels,
    roomKey,
    roomLoss,
    applyScopeChanges,
    defaultPhotoRename,
    ingestTranscript,
    closeTranscript,
    authStage,
    authMessage,
    authDomainFor,
    canonicalUrl,
    splitPhotos,
    missingItems,
    auditBlockMessage,
    noteFormat,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ADRCore = api;
})(typeof window === 'undefined' ? globalThis : window);
