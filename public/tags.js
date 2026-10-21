/* QR room and equipment tags: scan with the phone camera or type the printed code; print tags.
   Scans record where equipment stands; the priced equipment counts are never changed here. */
window.TagsUI = (() => {
  const {
    aspect,
    parseTag,
    applyTag,
    removeScan,
    placementsByRoom,
    roomScans,
    equipmentSummary,
    equipmentLabel,
    roomTagCode,
    equipmentTagCode,
  } = ADRCore;
  const JSQR_PATH = '/vendor/jsqr/1.4.0/jsQR.js',
    ASSET_ID = /^[A-Z0-9][A-Z0-9._/-]{0,31}$/,
    SAME_CODE_MS = 2500;
  const scanner = {
    stream: null,
    timer: null,
    detector: null,
    decoder: null,
    lastCode: '',
    lastAt: 0,
  };
  const sheet = { equipment: [], tags: null };
  const editable = () => canEditDraft('scope');
  const currentRoom = () => $('photoRoom').value;
  const time = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Walk & Photo list of scanned units by room, and each Check Scope room card's summary line.
  function render() {
    const data = state.draft?.data,
      list = $('equipmentPlacements');
    list.replaceChildren();
    const groups = data ? placementsByRoom(data) : [],
      total = groups.reduce((count, group) => count + group.scans.length, 0);
    $('tagCount').textContent = total
      ? total +
        (total === 1 ? ' unit' : ' units') +
        ' tagged · ' +
        groups.length +
        (groups.length === 1 ? ' room' : ' rooms')
      : 'No equipment tags scanned';
    if (!total)
      list.append(
        node(
          'p',
          'No equipment tags scanned on this job. Pick the current room, tap Scan tag and point the camera at the tag on the unit.',
          'empty',
        ),
      );
    for (const group of groups) {
      const block = node('div', undefined, 'placement-room'),
        items = node('ul');
      block.append(
        node('h4', group.room + (group.removed ? ' · room no longer on this job' : '')),
        items,
      );
      for (const scan of group.scans) {
        const item = node('li');
        item.append(
          node('span', equipmentLabel(scan.kind) + ' ' + scan.asset_id, 'placement-unit'),
          node('span', 'scanned ' + time(scan.scanned_at), 'placement-time'),
        );
        if (editable())
          item.append(
            button('Remove', () => {
              removeScan(state.draft.data, scan);
              changed(false);
              render();
            }),
          );
        items.append(item);
      }
      list.append(block);
    }
    document.querySelectorAll('#rooms .room').forEach((card, index) => {
      const room = data?.rooms[index];
      if (!room) return;
      const summary = equipmentSummary(roomScans(data, room.name));
      let line = card.querySelector('.room-equipment');
      if (!summary) {
        line?.remove();
        return;
      }
      if (!line) {
        line = node('p', undefined, 'room-equipment hint');
        card.append(line);
      }
      line.textContent =
        'Tagged equipment: ' + summary + ' · placement only, not the priced counts';
    });
  }
  function policy() {
    $('scanTag').disabled = !editable();
    $('printTags').disabled = !state.session || !state.draft;
  }

  // Scanner: the camera asks for permission; a refusal or a missing camera leaves typed entry.
  function report(message, ok) {
    const status = $('tagScanStatus');
    status.textContent = message;
    status.classList.toggle('refused', !ok);
    const entry = node('li', message);
    entry.classList.toggle('refused', !ok);
    $('tagScanLog').prepend(entry);
    while ($('tagScanLog').children.length > 12) $('tagScanLog').lastChild.remove();
  }
  function handleCode(text, source) {
    const now = Date.now();
    // The same tag staying in view is one scan, not one per frame.
    if (source === 'camera' && text === scanner.lastCode && now - scanner.lastAt < SAME_CODE_MS) {
      scanner.lastAt = now;
      return false;
    }
    scanner.lastCode = text;
    scanner.lastAt = now;
    if (!editable()) {
      report('This job can no longer be changed, so nothing was recorded.', false);
      return false;
    }
    const result = applyTag(parseTag(text), state.draft, currentRoom(), new Date());
    if (result.ok && result.type === 'room') {
      $('photoRoom').value = result.room.name;
      renderWalkRoomChips();
      $('tagScanRoom').textContent = result.room.name;
    }
    if (result.ok && result.type === 'equipment') {
      changed(false);
      render();
    }
    report(result.message, result.ok);
    return result.ok;
  }
  function cameraUnavailable(message) {
    $('tagCameraEmpty').textContent = message;
    $('retryTagCamera').hidden = false;
    $('tagCodeInput').focus();
  }
  async function loadDecoder() {
    if (scanner.decoder) return;
    if ('BarcodeDetector' in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          scanner.detector = new BarcodeDetector({ formats: ['qr_code'] });
          scanner.decoder = 'native';
          return;
        }
      } catch {}
    }
    if (typeof jsQR !== 'function')
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = JSQR_PATH;
        script.onload = resolve;
        script.onerror = () =>
          reject(Error('The QR reader could not load. Type the code printed on the tag.'));
        document.head.append(script);
      });
    scanner.decoder = 'jsqr';
  }
  async function decodeFrame(video) {
    const canvas = $('tagCanvas'),
      [width, height] = aspect(video.videoWidth, video.videoHeight, 640);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    if (scanner.detector) {
      try {
        return (await scanner.detector.detect(canvas))[0]?.rawValue || null;
      } catch {
        // A detector that cannot read canvases here falls back to the vendored reader.
        scanner.detector = null;
        scanner.decoder = null;
        await loadDecoder();
      }
    }
    if (typeof jsQR !== 'function') return null;
    const image = context.getImageData(0, 0, width, height);
    return jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data || null;
  }
  async function tick() {
    scanner.timer = null;
    const dialog = $('tagScanDialog'),
      video = $('tagVideo');
    if (!dialog.open) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const code = await decodeFrame(video);
        if (code) handleCode(code, 'camera');
      }
    } catch {}
    if (dialog.open && !scanner.timer) scanner.timer = setTimeout(tick, 150);
  }
  async function startCamera() {
    stopCamera();
    const video = $('tagVideo');
    $('retryTagCamera').hidden = true;
    $('tagCameraEmpty').textContent = 'Starting the camera…';
    if (state.media) {
      // Live already holds the camera; iPhones keep one capture, so its stream is shared here.
      video.srcObject = state.media;
    } else if (!navigator.mediaDevices?.getUserMedia) {
      cameraUnavailable('This browser has no camera access. Type the code printed on the tag.');
      return;
    } else {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (error) {
        cameraUnavailable(
          error.name === 'NotAllowedError' || error.name === 'SecurityError'
            ? 'Camera permission was denied. Allow the camera in your browser settings, or type the code printed on the tag.'
            : error.name === 'NotFoundError' || error.name === 'OverconstrainedError'
              ? 'No camera was found. Type the code printed on the tag.'
              : 'The camera could not start (' +
                (error.name || 'error') +
                '). Type the code printed on the tag.',
        );
        return;
      }
      if (!$('tagScanDialog').open) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      scanner.stream = stream;
      video.srcObject = stream;
    }
    await video.play().catch(() => {});
    $('tagScanDialog').classList.add('scanning');
    try {
      await loadDecoder();
    } catch (error) {
      cameraUnavailable(error.message);
      return;
    }
    $('tagCameraEmpty').textContent = '';
    if (!scanner.timer) scanner.timer = setTimeout(tick, 150);
  }
  function stopCamera() {
    clearTimeout(scanner.timer);
    scanner.timer = null;
    scanner.stream?.getTracks().forEach((track) => track.stop());
    scanner.stream = null;
    const video = $('tagVideo');
    video.pause?.();
    video.srcObject = null;
    $('tagScanDialog').classList.remove('scanning');
  }
  async function openScanner() {
    if (!editable()) throw Error('Open an editable draft before scanning tags.');
    $('tagScanRoom').textContent = currentRoom() || 'no room selected yet';
    $('tagScanStatus').textContent = '';
    $('tagScanStatus').classList.remove('refused');
    $('tagScanLog').replaceChildren();
    $('tagCodeInput').value = '';
    scanner.lastCode = '';
    $('tagScanDialog').showModal();
    await startCamera();
  }
  function applyTyped() {
    const input = $('tagCodeInput'),
      code = input.value.trim();
    if (!code) {
      report('Type the code printed under the QR square.', false);
      input.focus();
      return;
    }
    if (handleCode(code, 'manual')) input.value = '';
    input.focus();
  }

  // Printed sheet: room tags for this job and equipment tags by asset number.
  function renderRoomChoices() {
    const box = $('roomTagChoices');
    box.replaceChildren();
    const rooms = state.draft.data.rooms;
    if (!rooms.some((room) => room.name.trim())) {
      box.append(node('p', 'No rooms on this job yet. Add rooms first.', 'empty'));
      return;
    }
    rooms.forEach((room, index) => {
      if (!room.name.trim()) return;
      const label = node('label', undefined, 'check'),
        input = node('input');
      input.type = 'checkbox';
      input.checked = true;
      input.dataset.roomTag = index;
      label.append(input, node('span', room.name));
      box.append(label);
    });
  }
  function renderEquipmentChoices() {
    const list = $('equipmentTagList');
    list.replaceChildren();
    for (const entry of sheet.equipment) {
      const item = node('li');
      item.append(
        node('span', equipmentLabel(entry.kind) + ' ' + entry.asset_id),
        button('Remove', () => {
          sheet.equipment = sheet.equipment.filter((other) => other !== entry);
          renderEquipmentChoices();
        }),
      );
      list.append(item);
    }
  }
  function addEquipment() {
    const input = $('equipmentTagAsset'),
      asset_id = input.value.trim().toUpperCase(),
      kind = $('equipmentTagKind').value;
    if (!ASSET_ID.test(asset_id)) {
      $('tagSheetStatus').textContent =
        'Enter the asset or serial number: letters, digits and . _ / - only, up to 32 characters.';
      input.focus();
      return;
    }
    if (!sheet.equipment.some((entry) => entry.kind === kind && entry.asset_id === asset_id))
      sheet.equipment.push({ kind, asset_id });
    $('tagSheetStatus').textContent = '';
    input.value = '';
    input.focus();
    renderEquipmentChoices();
  }
  function tagCard(tag) {
    const card = node('figure', undefined, 'tag-card'),
      image = node('img'),
      caption = node('figcaption');
    image.src = tag.qr_svg;
    image.width = image.height = 160;
    image.alt = 'QR code for ' + tag.title + ' ' + tag.subtitle;
    caption.append(node('strong', tag.title), node('span', tag.subtitle), node('code', tag.code));
    card.append(image, caption);
    return card;
  }
  async function makeTags() {
    const data = state.draft.data,
      rooms = [...$('roomTagChoices').querySelectorAll('input:checked')]
        .map((input) => data.rooms[Number(input.dataset.roomTag)])
        .filter(Boolean),
      wanted = [
        ...rooms.map((room) => ({
          title: room.name,
          subtitle: data.address.trim() || 'Room tag for this job',
          code: roomTagCode(state.draft.inspection_id, room.name),
        })),
        ...sheet.equipment.map((entry) => ({
          title: equipmentLabel(entry.kind),
          subtitle: entry.asset_id,
          code: equipmentTagCode(entry.kind, entry.asset_id),
        })),
      ];
    if (!wanted.length) throw Error('Choose at least one room or add an equipment tag.');
    if (wanted.length > 60) throw Error('Make at most 60 tags per sheet.');
    if (!navigator.onLine)
      throw Error('Making tags needs a connection: the QR images come from the server.');
    $('makeTags').disabled = true;
    $('tagSheetStatus').textContent = 'Making ' + wanted.length + ' tags…';
    try {
      const { tags } = await jsonApi('/api/qr-tags', 'POST', {
        codes: wanted.map((tag) => tag.code),
      });
      sheet.tags = wanted.map((tag, index) => ({ ...tag, qr_svg: tags[index].qr_svg }));
    } finally {
      $('makeTags').disabled = false;
    }
    $('tagPreview').replaceChildren(...sheet.tags.map(tagCard));
    $('tagSheet').replaceChildren(...sheet.tags.map(tagCard));
    $('printTagSheet').hidden = false;
    $('tagSheetStatus').textContent =
      sheet.tags.length +
      (sheet.tags.length === 1 ? ' tag ready.' : ' tags ready.') +
      ' Tap Print.';
  }
  function printSheet() {
    if (!sheet.tags?.length) throw Error('Make tags first.');
    const done = () => {
      document.body.classList.remove('printing-tags');
      $('tagSheet').hidden = true;
    };
    document.body.classList.add('printing-tags');
    $('tagSheet').hidden = false;
    window.addEventListener('afterprint', done, { once: true });
    // Safari may return before printing and never fire afterprint; the sheet hides again shortly.
    setTimeout(done, 1500);
    window.print();
  }
  function openSheet() {
    if (!state.session || !state.draft) throw Error('Open a job first.');
    sheet.tags = null;
    $('tagPreview').replaceChildren();
    $('tagSheet').replaceChildren();
    $('printTagSheet').hidden = true;
    $('tagSheetStatus').textContent = '';
    renderRoomChoices();
    renderEquipmentChoices();
    $('tagSheetDialog').showModal();
  }
  function closeDialogs() {
    for (const id of ['tagScanDialog', 'tagSheetDialog']) if ($(id).open) $(id).close();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const click = (id, fn, statusId) =>
      $(id).addEventListener('click', () =>
        Promise.resolve(fn()).catch((error) => {
          if (statusId) {
            $(statusId).textContent = error.message;
            $(statusId).classList.add('refused');
          } else say(error.message, 'error');
        }),
      );
    click('scanTag', openScanner);
    click('closeTagScan', () => $('tagScanDialog').close());
    $('tagScanDialog').addEventListener('close', stopCamera);
    $('tagManualForm').addEventListener('submit', (event) => {
      event.preventDefault();
      applyTyped();
    });
    click('retryTagCamera', startCamera);
    click('printTags', openSheet);
    click('closeTagSheet', () => $('tagSheetDialog').close());
    $('equipmentTagForm').addEventListener('submit', (event) => {
      event.preventDefault();
      addEquipment();
    });
    $('makeTags').addEventListener('click', () => {
      $('tagSheetStatus').classList.remove('refused');
      makeTags().catch((error) => {
        $('tagSheetStatus').textContent = error.message;
        $('tagSheetStatus').classList.add('refused');
      });
    });
    click('printTagSheet', printSheet, 'tagSheetStatus');
  });
  return { render, policy, closeDialogs, handleCode };
})();
