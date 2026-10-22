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
    dehumidifier_ppd: 'Dehumidifier rating (AHAM pints/day)',
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
    floor_sf: 'Floor area SF',
    wet_floor_sf: 'Wet floor area SF',
    ceiling_height_ft: 'Ceiling height ft',
    water_class: 'Water class',
  };
  const roomKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const untouchedDefaultRoom = (room) =>
    room.name === 'Room 1' &&
    room.unfinished_sf === 0 &&
    room.finished_sf === 0 &&
    room.custom_cabinetry === false &&
    // A confirmed sizing input makes it the technician's room, not the untouched placeholder.
    ['floor_sf', 'wet_floor_sf', 'ceiling_height_ft', 'water_class'].every(
      (key) => room[key] == null,
    );
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
  // saved before the label existed reads as the tag it showed then: category 3 as mold, otherwise
  // water. Editable drafts take that value as their loss type when they open.
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
        }
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
  // The server's IICRC equipment-sizing check (backend/sizing.py) in the words Check Scope shows.
  // It is advice beside the technician's counts and never changes them or the prices.
  const plural = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');
  const listed = (items) =>
    items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);
  const range = (low, high) => (low === high ? String(low) : low + '–' + high);
  function roomSizingNote(check) {
    if (!check) return '';
    if (check.status === 'not_applicable') return 'mold only · no drying check';
    if (check.status === 'not_available')
      return 'check not available · ' + (check.problem || 'add ' + listed(check.missing));
    return (
      (check.air_movers_min == null
        ? 'air movers not sized: no wet floor'
        : range(check.air_movers_min, check.air_movers_max) + ' air movers') +
      ' · ' +
      check.dehumidifier_ppd +
      ' pints/day'
    );
  }
  function sizingSummary(sizing) {
    if (sizing.status === 'not_applicable')
      return { empty: 'No water rooms. The drying check applies to rooms with water.' };
    if (sizing.status === 'not_available') {
      const names = (rooms) => listed(rooms.map((room) => room.name.trim() || 'Unnamed room')),
        unavailable = sizing.rooms.filter((room) => room.status === 'not_available'),
        missing = unavailable.filter((room) => !room.problem),
        larger = unavailable.filter((room) => room.problem);
      return {
        empty: [
          'Check not available.',
          missing.length &&
            'Add the floor area, ceiling height and water class under More room options for ' +
              names(missing) +
              '.',
          larger.length &&
            'The wet floor area is larger than the floor area for ' + names(larger) + '.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    const movers = sizing.air_movers,
      dehus = sizing.dehumidifiers;
    return {
      rows: [
        {
          label: 'Air movers',
          recommended: movers.min == null ? 'not sized' : range(movers.min, movers.max),
          entered: String(movers.entered),
          flag: movers.flag,
          reason: movers.reason,
        },
        {
          label: 'Dehumidification',
          recommended:
            dehus.recommended_ppd +
            ' pints/day' +
            (dehus.unit_ppd == null
              ? ''
              : ' · ' + plural(dehus.recommended_units, 'unit') + ' at ' + dehus.unit_ppd),
          entered: plural(dehus.entered, 'LGR dehumidifier'),
          flag: dehus.flag,
          reason: dehus.reason,
        },
      ],
    };
  }
  // The closed More equipment & labor drawer's note: every flag in words, or why there is none.
  const sizingFlagWords = { below: 'below', within: 'within range', above: 'above' };
  function sizingNote(sizing) {
    const summary = sizingSummary(sizing);
    if (summary.empty)
      return sizing.status === 'not_applicable'
        ? '· no water rooms to size'
        : '· sizing check not available';
    const words = summary.rows
      .filter((row) => row.flag)
      .map((row) => '· ' + row.label + ' ' + sizingFlagWords[row.flag]);
    if (sizing.air_movers.min == null) words.unshift('· air movers not sized');
    return words.length ? words.join(' ') : '· sizing: add the dehumidifier rating';
  }
  // A signed record keeps only what it saved. Rooms it never stored stay absent, so no default
  // room or loss tag is invented for it; a new job starts from emptyData() instead.
  function signedDraftData(record) {
    return { ...emptyData(), rooms: [], ...record.inspection, address: record.address };
  }
  // QR tags. The printed code is the QR payload and the text a technician types when the camera
  // is unavailable; backend/tags.py reads the same format. Room tags carry the first 8 hex digits
  // of the job id, so a tag printed for another job is refused instead of picking a same-named room.
  const EQUIPMENT_KINDS = { AM: 'air_mover', DH: 'dehumidifier', AS: 'air_scrubber' },
    EQUIPMENT_CODES = { air_mover: 'AM', dehumidifier: 'DH', air_scrubber: 'AS' },
    equipmentLabels = {
      air_mover: ['Air mover', 'Air movers'],
      dehumidifier: ['LGR dehumidifier', 'LGR dehumidifiers'],
      air_scrubber: ['Air scrubber', 'Air scrubbers'],
    },
    ROOM_TAG = /^DS1-RM-([a-f0-9]{8})-([^\r\n]{1,100})$/i,
    EQUIPMENT_TAG = /^DS1-EQ-(AM|DH|AS)-([A-Z0-9][A-Z0-9._/-]{0,31})$/i;
  const equipmentLabel = (kind, count = 1) => equipmentLabels[kind][count === 1 ? 0 : 1];
  const jobTag = (inspectionId) => inspectionId.slice(8, 16).toLowerCase();
  const roomTagCode = (inspectionId, room) =>
    'DS1-RM-' + jobTag(inspectionId) + '-' + room.trim().replace(/\s+/g, ' ');
  const equipmentTagCode = (kind, assetId) =>
    'DS1-EQ-' + EQUIPMENT_CODES[kind] + '-' + assetId.trim().toUpperCase();
  function parseTag(text) {
    const code = String(text ?? '').trim();
    let match = ROOM_TAG.exec(code);
    if (match) {
      const room = match[2].trim().replace(/\s+/g, ' ');
      if (room) return { type: 'room', job: match[1].toLowerCase(), room, code };
    }
    match = EQUIPMENT_TAG.exec(code);
    if (match) {
      const kind = EQUIPMENT_KINDS[match[1].toUpperCase()],
        asset_id = match[2].toUpperCase();
      return { type: 'equipment', kind, asset_id, code: equipmentTagCode(kind, asset_id) };
    }
    return { type: 'unknown', code };
  }
  // Rooms whose names match once normalised share one tag code, so scanning and printing refuse
  // them until they are renamed. Returns the refusal when any of the chosen rooms clashes, else ''.
  function roomNameClash(rooms, chosen = rooms) {
    const groups = new Map();
    for (const room of rooms) {
      const key = roomKey(room.name);
      if (key) groups.set(key, [...(groups.get(key) || []), room]);
    }
    const clashing = [...groups.values()].filter(
      (group) => group.length > 1 && group.some((room) => chosen.includes(room)),
    );
    if (!clashing.length) return '';
    return (
      'Rooms ' +
      clashing
        .flat()
        .map((room) => '"' + room.name + '"')
        .join(', ') +
      ' have the same name. Give each room a distinct name, then try again; nothing was changed.'
    );
  }
  const sameAsset = (a, b) => a.kind === b.kind && a.asset_id === b.asset_id;
  // What a scanned code means for the open draft. A room tag names the current room; an equipment
  // tag records that asset in the current room at the scan time, replacing its earlier placement.
  // Nothing here touches the priced equipment counts. Returns the outcome and mutates draft.data
  // only for a recorded equipment scan.
  function applyTag(parsed, draft, currentRoom, now = new Date(), id = null) {
    const data = draft.data;
    if (parsed.type === 'unknown') {
      return {
        ok: false,
        type: 'unknown',
        message:
          (parsed.code
            ? 'Not a DryScope tag: "' + parsed.code.slice(0, 40) + '". '
            : 'No code was read. ') +
          'Room tags read DS1-RM-… and equipment tags DS1-EQ-…; nothing was recorded.',
      };
    }
    const clash = roomNameClash(data.rooms);
    if (clash) return { ok: false, type: parsed.type, message: clash };
    if (parsed.type === 'room') {
      if (parsed.job !== jobTag(draft.inspection_id))
        return {
          ok: false,
          type: 'room',
          message: 'This room tag was printed for a different job. Nothing was changed.',
        };
      const room = data.rooms.find((entry) => roomKey(entry.name) === roomKey(parsed.room));
      if (!room)
        return {
          ok: false,
          type: 'room',
          message:
            'No room named "' +
            parsed.room +
            '" is on this job. Add it with + Room or pick another room; nothing was changed.',
        };
      return { ok: true, type: 'room', room, message: 'Current room: ' + room.name + '.' };
    }
    const room = data.rooms.find((entry) => entry.name === currentRoom);
    if (!room)
      return {
        ok: false,
        type: 'equipment',
        message:
          'Choose the current room first, then scan the equipment tag. Nothing was recorded.',
      };
    const scans = data.equipment_scans || [],
      previous = scans.find((scan) => sameAsset(scan, parsed)),
      scan = {
        id: id || previous?.id || crypto.randomUUID().replaceAll('-', ''),
        kind: parsed.kind,
        asset_id: parsed.asset_id,
        room: room.name,
        // Whole seconds: the server stores the same text it was sent, so a reloaded draft's
        // acknowledged copy still matches the saved record instead of reading as a conflict.
        scanned_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
    if (!previous && scans.length >= 200)
      return {
        ok: false,
        type: 'equipment',
        message: 'At most 200 equipment tags can be recorded on one job. Nothing was recorded.',
      };
    data.equipment_scans = [...scans.filter((entry) => entry !== previous), scan];
    const moved = previous && roomKey(previous.room) !== roomKey(room.name) ? previous.room : null;
    return {
      ok: true,
      type: 'equipment',
      scan,
      moved_from: moved,
      message:
        equipmentLabel(parsed.kind) +
        ' ' +
        parsed.asset_id +
        (moved ? ' moved from ' + moved + ' to ' : ' placed in ') +
        room.name +
        ' · ' +
        now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        '.',
    };
  }
  function removeScan(data, scan) {
    const scans = (data.equipment_scans || []).filter((entry) => entry.id !== scan.id);
    if (scans.length) data.equipment_scans = scans;
    else delete data.equipment_scans;
    return scans.length;
  }
  // Scans grouped by room in the job's room order; a room no longer on the job keeps its scans
  // under the stored name after the others. Each group's scans are in scan order.
  function placementsByRoom(data) {
    const scans = data.equipment_scans || [],
      groups = data.rooms.map((room) => ({ room: room.name, scans: [] }));
    for (const scan of scans) {
      let group = groups.find((entry) => roomKey(entry.room) === roomKey(scan.room));
      if (!group) {
        group = { room: scan.room, scans: [], removed: true };
        groups.push(group);
      }
      group.scans.push(scan);
    }
    return groups.filter((group) => group.scans.length);
  }
  const roomScans = (data, room) =>
    (data.equipment_scans || []).filter((scan) => roomKey(scan.room) === roomKey(room));
  // "2 air movers, 1 LGR dehumidifier" in kind order; '' when nothing is tagged.
  function equipmentSummary(scans) {
    return Object.keys(equipmentLabels)
      .map((kind) => scans.filter((scan) => scan.kind === kind).length)
      .map((count, i) => {
        if (!count) return '';
        const label = equipmentLabel(Object.keys(equipmentLabels)[i], count);
        // "air mover" mid-sentence, but an acronym such as LGR keeps its case.
        const lower = label[1] === label[1].toLowerCase();
        return count + ' ' + (lower ? label[0].toLowerCase() + label.slice(1) : label);
      })
      .filter(Boolean)
      .join(', ');
  }
  const api = {
    emptyData,
    signedDraftData,
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
    equipmentLabel,
    roomTagCode,
    equipmentTagCode,
    parseTag,
    roomNameClash,
    applyTag,
    removeScan,
    placementsByRoom,
    roomScans,
    equipmentSummary,
    roomSizingNote,
    sizingSummary,
    sizingNote,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ADRCore = api;
})(typeof window === 'undefined' ? globalThis : window);
