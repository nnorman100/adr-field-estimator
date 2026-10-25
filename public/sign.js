/* Homeowner signing page: no sign-in. The link's token stays in the URL fragment and travels only in one request header.
   At /documents the same page is the read-only document link: the signing area stays off and the
   token names a signed agreement's document set instead of a pending estimate. */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const token = location.hash.slice(1);
  const readOnly = location.pathname === '/documents';
  const api = readOnly ? '/api/documents' : '/api/sign';
  const header = readOnly ? 'X-ADR-Document-Link' : 'X-ADR-Signing-Link';
  const sender = readOnly ? 'the restoration company' : 'your technician';
  const TAB_TITLES = {
    proposal: 'Signed proposal',
    claim: 'Itemized claim',
    defense: 'Scope defense letter',
    photos: 'Photo audit log',
  };
  const page = {
    view: null,
    viewed: new Set(),
    signature: null,
    // A retry after a lost response resends the identical submission, so the server returns the same receipt.
    pending: null,
    photoUrls: new Map(),
  };
  function status(text, type = '') {
    const el = $('signStatus');
    el.textContent = text;
    el.className = 'message ' + type;
    el.hidden = !text;
  }
  function fail(text) {
    $('signError').textContent = text;
    $('signError').hidden = !text;
  }
  async function call(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      headers: { ...options.headers, [header]: token },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Error(
        typeof payload.detail === 'string'
          ? payload.detail
          : 'The request could not be completed. Check your connection and retry.',
      );
    }
    return response;
  }
  const roleLabel = (role) =>
    role === 'owner' ? 'property owner' : 'authorized representative of the owner';
  function photos() {
    return page.view.documents.photo_audit_log || [];
  }
  // The read-only link shows one document set; the signing link shows all four.
  function tabs() {
    return readOnly ? page.view.tabs : ['proposal', 'claim', 'defense', 'photos'];
  }
  function signedText(receipt, when) {
    const who = receipt.signer_name
      ? ' by ' + receipt.signer_name + ', ' + roleLabel(receipt.signer_role) + ','
      : '';
    return 'Signed' + who + ' on ' + when + '. Reference ' + receipt.auth_id + '.';
  }
  function renderReadOnly(view) {
    const shown = tabs(),
      receipt = view.receipt,
      when = new Date(receipt.timestamp).toLocaleString();
    document.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.hidden = !shown.includes(tab.dataset.tab);
    });
    for (const name of Object.keys(TAB_TITLES))
      $('doc-' + name).classList.toggle('document-excluded', !shown.includes(name));
    document.querySelector('#documents .section-head h2').textContent = shown
      .map((name) => TAB_TITLES[name])
      .join(' and ');
    document.querySelector('.totals-summary').hidden = !shown.includes('proposal');
    $('documentProgress').hidden = true;
    $('downloadScope').hidden = !shown.includes('claim');
    $('homeownerSigning').hidden = true;
    $('signedReceipt').hidden = false;
    $('receiptText').textContent = signedText(receipt, when);
    $('signedNotice').hidden = !shown.includes('proposal');
    $('signedNotice').textContent = receipt.signer_name
      ? 'Signed electronically by ' +
        receipt.signer_name +
        ' (' +
        roleLabel(receipt.signer_role) +
        ') on ' +
        when +
        ' · Reference ' +
        receipt.auth_id
      : 'Signed on ' + when + ' · Reference ' + receipt.auth_id;
    $('viewUntil').textContent =
      'This link opens the signed documents until ' +
      new Date(view.expires_at).toLocaleDateString() +
      '.';
  }
  function render() {
    const view = page.view,
      docs = view.documents;
    document.body.classList.add('has-documents');
    ADRDocuments.render(docs, photos(), (photo) => page.photoUrls.get(photo.id) || '');
    const company = ADRDocuments.brand(docs);
    $('signFooter').textContent = [company, 'Private estimate review'].filter(Boolean).join(' · ');
    if (readOnly) return renderReadOnly(view);
    const signed = view.status === 'signed';
    $('homeownerSigning').hidden = signed;
    $('signedReceipt').hidden = !signed;
    $('signedNotice').hidden = !signed;
    if (signed) {
      const receipt = view.receipt,
        when = new Date(receipt.timestamp).toLocaleString();
      $('receiptText').textContent =
        'Signed by ' +
        receipt.signer_name +
        ', ' +
        roleLabel(receipt.signer_role) +
        ', on ' +
        when +
        '. Reference ' +
        receipt.auth_id +
        '.';
      $('signedNotice').textContent =
        'Signed electronically by ' +
        receipt.signer_name +
        ' (' +
        roleLabel(receipt.signer_role) +
        ') on ' +
        when +
        ' · Reference ' +
        receipt.auth_id;
      $('viewUntil').textContent =
        'You can reopen this link to view or print the signed estimate until ' +
        new Date(view.view_until).toLocaleDateString() +
        '.';
    } else {
      $('consentReviewedText').textContent = view.consent.statements[0];
      $('consentElectronicText').textContent = view.consent.statements[1];
      $('linkExpiry').textContent =
        'This link expires ' + new Date(view.expires_at).toLocaleString() + '.';
      gate();
    }
  }
  function gate() {
    const ready = page.viewed.size === 4;
    $('signFields').disabled = !ready;
    $('signGate').textContent = ready
      ? 'All four documents opened. Complete the details below to sign.'
      : 'Open all four documents above before signing (' + page.viewed.size + ' of 4 opened).';
    if (ready) requestAnimationFrame(resizeSignature);
  }
  function select(name) {
    if (!page.view) return;
    ADRDocuments.select(name, page.viewed);
    if (page.view.status !== 'signed') gate();
  }
  async function loadPhotos() {
    // One at a time: each read is a counted transaction on the link.
    for (const photo of photos()) {
      if (page.photoUrls.has(photo.id)) continue;
      try {
        const blob = await (await call(api + '/photos/' + encodeURIComponent(photo.id))).blob();
        page.photoUrls.set(photo.id, URL.createObjectURL(blob));
      } catch {
        // The log still lists the photo; its image stays blank.
      }
    }
  }
  async function loadSignature() {
    try {
      const blob = await (await call(api + '/signature')).blob();
      $('savedSignature').src = URL.createObjectURL(blob);
      $('savedSignature').hidden = false;
    } catch {
      $('savedSignature').hidden = true;
    }
  }
  async function load() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      status(
        (readOnly ? 'This document link' : 'This signing link') +
          ' is incomplete. Open the full link ' +
          sender +
          ' sent.',
        'error',
      );
      return;
    }
    try {
      page.view = await (await call(api)).json();
    } catch (e) {
      $('signMain').hidden = true;
      status(e.message, 'error');
      return;
    }
    status('');
    $('signMain').hidden = false;
    if (!page.viewed.size) select(tabs()[0]);
    render();
    await loadPhotos();
    render();
    if (page.view.status === 'signed' && tabs().includes('proposal')) await loadSignature();
  }
  // The adjuster's set carries the same scope-code JSON the app exports (ADR internal codes, no
  // ESX compatibility claim).
  function downloadScope() {
    const text = JSON.stringify(page.view.documents.xactimate_scope || [], null, 2),
      url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
      link = document.createElement('a');
    link.href = url;
    link.download = 'scope.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function describeReadOnly() {
    document.title = 'Your signed estimate documents';
    document.querySelector('.sign-header .eyebrow').textContent = 'SIGNED ESTIMATE';
    document.querySelector('.sign-header h1').textContent = 'Your signed estimate documents';
    document.querySelector('.sign-header .hint').textContent =
      'The restoration company sent you this private link to the signed documents. ' +
      'Read, print or save them here. No account or password is needed.';
    $('signStatus').textContent = 'Loading the signed documents…';
    $('homeownerSigning').hidden = true;
    $('documentProgress').hidden = true;
  }
  function resizeSignature() {
    const canvas = $('signCanvas'),
      rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = Math.round(rect.width * devicePixelRatio);
    canvas.height = Math.round(180 * devicePixelRatio);
    canvas.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (page.signature) {
      const image = new Image();
      image.onload = () => canvas.getContext('2d').drawImage(image, 0, 0, rect.width, 180);
      image.src = page.signature;
    }
  }
  function clearSignature() {
    const canvas = $('signCanvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    page.signature = null;
    page.pending = null;
  }
  function initSignature() {
    const canvas = $('signCanvas');
    let drawing = false,
      moved = false;
    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if ($('signFields').disabled) return;
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      moved = false;
      const p = point(e),
        ctx = canvas.getContext('2d');
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      page.pending = null;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = point(e),
        ctx = canvas.getContext('2d');
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#111';
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      moved = true;
    });
    const end = () => {
      if (drawing && moved) page.signature = canvas.toDataURL('image/png');
      drawing = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => resizeSignature()).observe(canvas);
  }
  function missing() {
    const role = document.querySelector('input[name=signerRole]:checked');
    if (page.viewed.size !== 4) return ['Open all four documents before signing.', $('signGate')];
    if (!$('signerName').value.trim()) return ['Type your full name.', $('signerName')];
    if (!role)
      return [
        'Choose whether you are the owner or an authorized representative.',
        document.querySelector('input[name=signerRole]'),
      ];
    if (!$('consentReviewed').checked || !$('consentElectronic').checked)
      return ['Check both confirmations to sign.', $('consentReviewed')];
    if (!page.signature) return ['Draw your signature in the box.', $('clearSignature')];
    return null;
  }
  async function submit(event) {
    event.preventDefault();
    fail('');
    const problem = missing();
    if (problem) {
      fail(problem[0]);
      problem[1].focus?.();
      return;
    }
    const body = page.pending || {
      signer_name: $('signerName').value.trim(),
      signer_role: document.querySelector('input[name=signerRole]:checked').value,
      documents_reviewed: true,
      electronic_consent: true,
      consent_version: page.view.consent.version,
      signature_png: page.signature,
    };
    page.pending = body;
    $('submitSignature').disabled = true;
    status('Saving your signature…');
    try {
      const receipt = await (
        await call('/api/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
      if (receipt.status !== 'success') throw Error('Signing was not confirmed. Retry.');
      page.pending = null;
      // The confirmation shows only what the server reports for this link.
      await load();
      if (page.view?.status === 'signed') {
        // Show the proposal with the signed notice and the saved signature.
        select('proposal');
        status('Signed. Thank you.', 'success');
      }
    } catch (e) {
      status('', '');
      fail('Not signed yet: ' + e.message);
    } finally {
      $('submitSignature').disabled = false;
    }
  }
  function init() {
    const canonical = ADRCore.canonicalUrl(location.href);
    if (canonical) return location.replace(canonical);
    document
      .querySelectorAll('[data-tab]')
      .forEach((tab) => tab.addEventListener('click', () => select(tab.dataset.tab)));
    for (const id of ['signerName', 'consentReviewed', 'consentElectronic'])
      $(id).addEventListener('input', () => (page.pending = null));
    document
      .querySelectorAll('input[name=signerRole]')
      .forEach((input) => input.addEventListener('change', () => (page.pending = null)));
    $('clearSignature').addEventListener('click', clearSignature);
    $('signForm').addEventListener('submit', (e) => submit(e));
    $('printDocuments').addEventListener('click', () => window.print());
    $('downloadScope').addEventListener('click', downloadScope);
    if (readOnly) describeReadOnly();
    else initSignature();
    load();
  }
  init();
})();
