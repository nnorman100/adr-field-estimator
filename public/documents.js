/* The four claim documents, built from text nodes only; shared by the app and the homeowner signing page. */
'use strict';
(function (root) {
  const { money, estimateLabel } = root.ADRCore;
  const $ = (id) => document.getElementById(id);
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function paragraphs(parent, values) {
    for (const value of Array.isArray(values) ? values : [values]) parent.append(node('p', value));
  }
  // viewed is the caller's set of opened documents; signing waits until it holds all four.
  function select(name, viewed) {
    viewed.add(name);
    document.querySelectorAll('[data-tab]').forEach((tab) => {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle('selected', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    document.querySelectorAll('.doc').forEach((doc) => (doc.hidden = doc.id !== 'doc-' + name));
    $('documentProgress').textContent =
      viewed.size + ' of 4 documents opened · Review each before signing.';
  }
  // Photos in photo-log order, each labelled "Photo N (Room)" as the findings cite them.
  function numbered(docs, photos) {
    const order = (docs.photo_audit_log || []).map((photo) => photo.id),
      position = (photo) => (order.includes(photo.id) ? order.indexOf(photo.id) : order.length);
    return [...photos]
      .sort((a, b) => position(a) - position(b))
      .map((photo, i) => ({ photo, label: 'Photo ' + (i + 1) + ' (' + photo.room + ')' }));
  }
  function render(docs, photos, photoUrl, legacyIdentity) {
    const identity = docs.company_identity || legacyIdentity || {};
    $('estimateRange').textContent = estimateLabel(docs.adr_estimate);
    $('itemizedTotal').textContent = money(docs.xactimate_total);
    const p = docs.adr_estimate,
      body = $('proposalBody'),
      customer = p.customer_name ? ['Customer: ' + p.customer_name] : [];
    body.replaceChildren();
    paragraphs(body, [
      ...customer,
      p.property_address,
      p.date || '',
      'Estimator: ' + (identity.signoff || '') + ' · CSLB #' + (identity.license || ''),
    ]);
    body.append(
      node('p', 'Customer estimate range: ' + estimateLabel(p), 'money'),
      node('p', 'Itemized charges at base rates: ' + money(docs.xactimate_total)),
    );
    body.append(node('h3', 'Findings'));
    paragraphs(body, p.findings);
    body.append(node('h3', 'Proposed scope'));
    paragraphs(body, p.recommendations);
    paragraphs(body, p.disclaimers || []);
    if (docs.ai_summary) {
      body.append(node('h3', 'AI summary · technician review required'));
      paragraphs(body, docs.ai_summary);
    }
    if (docs.ai_suggestions?.length) {
      body.append(node('h3', 'AI suggestions · outside the authorized scope'));
      paragraphs(body, docs.ai_suggestions);
    }
    $('claimParty').replaceChildren();
    paragraphs($('claimParty'), [...customer, 'Property: ' + p.property_address]);
    $('claimItems').replaceChildren();
    for (const item of docs.xactimate_scope) {
      const row = node('tr');
      for (const text of [
        item.code + ' · ' + (item.description || item.desc),
        String(item.quantity ?? item.qty) + ' ' + item.unit,
        money(item.unit_price ?? item.price),
        String(item.waste_percent ?? item.waste ?? 0) + '%',
        money(item.total),
      ])
        row.append(node('td', text));
      $('claimItems').append(row);
    }
    $('claimCards').replaceChildren();
    for (const item of docs.xactimate_scope) {
      const card = node('section', undefined, 'claim-card');
      card.append(
        node('span', item.code, 'claim-code'),
        node('h3', item.description || item.desc),
        node(
          'div',
          String(item.quantity ?? item.qty) +
            ' ' +
            item.unit +
            ' × ' +
            money(item.unit_price ?? item.price),
        ),
        node('div', 'Waste: ' + String(item.waste_percent ?? item.waste ?? 0) + '%'),
        node('p', 'Total: ' + money(item.total), 'item-total'),
      );
      $('claimCards').append(card);
    }
    $('claimTotal').textContent = 'Itemized claim total: ' + money(docs.xactimate_total);
    $('defenseBody').textContent = docs.iicrc_defense_letter;
    $('photoAuditLog').replaceChildren();
    const log = numbered(docs, photos);
    for (const { photo, label } of log) {
      const entry = node('div', undefined, 'audit-photo'),
        img = node('img');
      img.src = photoUrl(photo);
      img.alt = photo.room + ' evidence';
      const detail = node('div');
      paragraphs(detail, [
        label,
        new Date(photo.captured_at).toLocaleString(),
        (photo.width || '?') + ' × ' + (photo.height || '?') + ' pixels',
        photo.ocr_status === 'verified'
          ? 'Verified meter: ' + photo.ocr.meter_type + ' · ' + photo.ocr.value
          : 'Unverified: ' + photo.ocr_status.replaceAll('_', ' '),
      ]);
      entry.append(img, detail);
      $('photoAuditLog').append(entry);
    }
    if (!photos.length)
      $('photoAuditLog').append(node('p', 'No photographs were attached to this inspection.'));
    const warnings = [
      ...(docs.company_setup_missing || []).map((text) => 'Company setup required: ' + text),
      ...(docs.unpriced_work || []).map((text) => 'Unpriced work: ' + text),
      ...log
        .filter(({ photo }) => photo.ocr_status === 'pending')
        .map(({ label }) => 'Recognition pending: ' + label),
    ];
    $('auditWarnings').textContent = warnings.join(' · ');
    $('auditWarnings').hidden = !warnings.length;
  }
  // Temporary fallback until ADR's profile stores its logo; PR 2 uploads it and removes this.
  const ADR_LOGO_FALLBACK = '/brand/adr-logo.jpg';
  // A saved profile logo always wins; only company 'adr' falls back to the bundled logo.
  function logoFor(identity) {
    return identity?.logo_data_url || (identity?.company_id === 'adr' ? ADR_LOGO_FALLBACK : '');
  }
  // Pre-workspace records use the historical identity supplied by the backend, never a live profile.
  function brand(docs, legacyIdentity) {
    const identity = docs.company_identity || legacyIdentity || {};
    const name = identity.name || '';
    document.querySelector('#doc-proposal > h2').textContent = name + ' · Official proposal';
    for (const letter of document.querySelectorAll('.document-letterhead')) {
      letter.querySelector('p').textContent = [
        identity.address,
        identity.phone,
        identity.license ? 'CSLB #' + identity.license : 'License not provided',
      ]
        .filter(Boolean)
        .join(' · ');
      const image = letter.querySelector('img');
      const logo = logoFor(identity);
      image.hidden = !logo;
      if (logo) image.src = logo;
      else image.removeAttribute('src');
      image.alt = name;
    }
    document.querySelector('[data-tab=proposal]').textContent = 'Proposal';
    return name;
  }
  root.ADRDocuments = { node, select, render, brand, logoFor };
})(window);
