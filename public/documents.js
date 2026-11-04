/* The four claim documents, built from text nodes only; shared by the app and the homeowner signing page. */
'use strict';
(function (root) {
  const { money, estimateLabel, estimateHeading, claimLines, locationLabel, locationUrl } =
    root.ADRCore;
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
  // viewed is the caller's set of opened documents; the homeowner link waits until it holds all four.
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
  function pricedFrom(basis) {
    const sequence = Number(basis?.sequence) || 0;
    if (sequence) return 'Priced from Prices v' + sequence + '.';
    return basis?.company_id === 'adr' ? 'Priced from ADR starting prices.' : '';
  }
  // The summary lines that add up to a total, from the saved estimate. A line prints when either
  // end has an amount, so low and high columns always show the same rows.
  function summaryLines(estimate) {
    const { low, high } = estimate,
      both = (key) => Number(low[key]) > 0 || (high && Number(high[key]) > 0),
      percent = (value) => ' (' + value + '%)';
    return [
      ['Subtotal of itemized work', 'subtotal', true],
      [
        estimate.after_hours_label + percent(estimate.after_hours_percent),
        'after_hours',
        both('after_hours'),
      ],
      ['Minimum job charge', 'minimum_charge', both('minimum_charge')],
      [
        'Overhead and profit' + percent(estimate.overhead_profit_percent),
        'overhead_profit',
        both('overhead_profit'),
      ],
      ['Sales tax' + percent(estimate.sales_tax_percent), 'tax', both('tax')],
      ['Total', 'total', true],
    ].filter(([, , show]) => show);
  }
  function summaryTable(estimate) {
    const table = node('table', undefined, 'estimate-summary'),
      head = node('tr'),
      ranged = !!estimate.high;
    head.append(
      node('th', ''),
      node('th', ranged ? 'Low' : 'Price'),
      ...(ranged ? [node('th', 'High')] : []),
    );
    const thead = node('thead'),
      body = node('tbody');
    thead.append(head);
    for (const [label, key] of summaryLines(estimate)) {
      const row = node('tr', undefined, key === 'total' ? 'estimate-total' : '');
      row.append(
        node('th', label),
        node('td', money(estimate.low[key])),
        ...(ranged ? [node('td', money(estimate.high[key]))] : []),
      );
      body.append(row);
    }
    table.append(thead, body);
    // Not .table-scroll: phones hide that class and show the claim cards instead.
    const wrap = node('div', undefined, 'estimate-summary-wrap');
    wrap.append(table);
    return wrap;
  }
  // Under the itemized table: the low end's subtotal and adjustments, then the claim total.
  function claimAdjustmentLines(estimate) {
    return summaryLines({ ...estimate, high: null })
      .filter(([, key]) => key !== 'total')
      .map(([label, key]) => node('p', label + ': ' + money(estimate.low[key])));
  }
  function lineBreakdown(lines) {
    const list = node('ul', undefined, 'line-breakdown');
    for (const item of lines)
      list.append(
        node(
          'li',
          item.description +
            ' · ' +
            String(item.quantity) +
            ' ' +
            item.unit +
            ' · ' +
            money(item.total),
        ),
      );
    return list;
  }
  function render(docs, photos, photoUrl) {
    const identity = docs.company_identity || {};
    const license = identity.license ? 'CSLB #' + identity.license : '';
    const estimator = [identity.signoff, license].filter(Boolean).join(' · ');
    const p = docs.adr_estimate,
      estimate = docs.estimate;
    $('estimateHeading').textContent = estimateHeading(p.estimate_mode);
    $('estimateRange').textContent = estimateLabel(p);
    $('itemizedHeading').textContent = estimate ? 'Itemized total' : 'Itemized scope total';
    $('itemizedTotal').textContent = money(docs.xactimate_total);
    const body = $('proposalBody'),
      customer = p.customer_name ? ['Customer: ' + p.customer_name] : [],
      // The claim details saved with the audit; documents from before claim details carry none.
      claim = claimLines(docs.claim);
    body.replaceChildren();
    paragraphs(body, [
      ...customer,
      p.property_address,
      p.date || '',
      ...(estimator ? ['Estimator: ' + estimator] : []),
      ...claim,
    ]);
    body.append(node('p', estimateHeading(p.estimate_mode) + ': ' + estimateLabel(p), 'money'));
    if (estimate) {
      // Price-table documents show how the amount adds up; the explanation follows it.
      body.append(summaryTable(estimate));
      if (estimate.explanation) body.append(node('p', estimate.explanation));
      if (estimate.show_line_breakdown)
        body.append(lineBreakdown(estimate.lines || docs.xactimate_scope || []));
    } else body.append(node('p', 'Itemized scope total: ' + money(docs.xactimate_total)));
    const priced = pricedFrom(docs.price_basis);
    if (priced) body.append(node('p', priced));
    // A read-only document link outside the proposal's set delivers the proposal emptied.
    body.append(node('h3', 'Findings'));
    paragraphs(body, p.findings || []);
    body.append(node('h3', 'Proposed scope'));
    paragraphs(body, p.recommendations || []);
    paragraphs(body, p.disclaimers || []);
    // AI notes are for the estimator only: link answers omit them and the signing page has no #auditNotes.
    const notes = $('auditNotesBody');
    if (notes) {
      notes.replaceChildren();
      if (docs.ai_summary) {
        notes.append(node('h3', 'AI summary · technician review required'));
        paragraphs(notes, docs.ai_summary);
      }
      if (docs.ai_suggestions?.length) {
        notes.append(node('h3', 'AI suggestions · outside the authorized scope'));
        paragraphs(notes, docs.ai_suggestions);
      }
      $('auditNotes').hidden = !notes.childElementCount;
    }
    // Quantity overrides reach only the owner: the server omits them for everyone else, and the
    // panel sits on Check Scope, away from the review screen used for in-person signing.
    const quantity = $('quantityNotesBody');
    if (quantity) {
      quantity.replaceChildren();
      for (const note of docs.quantity_notes || [])
        quantity.append(
          node(
            'p',
            [
              note.label + (note.room ? ' (' + note.room + ')' : ''),
              'measured ' + note.measured + ', entered ' + note.entered,
              'Reason: ' + note.reason,
            ].join(' · '),
          ),
        );
      $('quantityNotes').hidden = !quantity.childElementCount;
    }
    $('claimParty').replaceChildren();
    paragraphs($('claimParty'), [...customer, 'Property: ' + p.property_address, ...claim]);
    $('claimItems').replaceChildren();
    const scope = docs.xactimate_scope || [],
      // The Xactimate column appears only when the company entered a code on at least one line.
      withCodes = scope.some((item) => item.xactimate_code);
    $('claimXactimateHead').hidden = !withCodes;
    $('claimHint').textContent = withCodes
      ? 'Xactimate codes shown where the company entered them. This is not an Xactimate (ESX) file.'
      : 'Internal scope codes (not Xactimate codes). JSON export does not guarantee Xactimate import compatibility.';
    for (const item of scope) {
      const row = node('tr');
      for (const text of [
        item.code + ' · ' + (item.description || item.desc),
        String(item.quantity ?? item.qty) + ' ' + item.unit,
        money(item.unit_price ?? item.price),
        String(item.waste_percent ?? item.waste ?? 0) + '%',
        money(item.total),
        ...(withCodes ? [item.xactimate_code || ''] : []),
      ])
        row.append(node('td', text));
      $('claimItems').append(row);
    }
    $('claimCards').replaceChildren();
    for (const item of scope) {
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
        ...(item.xactimate_code ? [node('div', 'Xactimate: ' + item.xactimate_code)] : []),
        node('p', 'Total: ' + money(item.total), 'item-total'),
      );
      $('claimCards').append(card);
    }
    $('claimAdjustments').className = 'claim-summary';
    $('claimAdjustments').replaceChildren(...(estimate ? claimAdjustmentLines(estimate) : []));
    $('claimTotal').textContent = 'Itemized claim total: ' + money(docs.xactimate_total);
    $('defenseBody').textContent = docs.iicrc_defense_letter || '';
    $('photoParty').replaceChildren();
    paragraphs($('photoParty'), claim);
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
      detail.append(node('p', locationLabel(photo.location)));
      const map = locationUrl(photo.location);
      if (map) {
        const link = node('a', 'Open in Google Maps');
        link.href = map;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        detail.lastChild.append(' · ', link);
      }
      entry.append(img, detail);
      $('photoAuditLog').append(entry);
    }
    if (!photos.length)
      $('photoAuditLog').append(node('p', 'No photographs were attached to this inspection.'));
    const warnings = [
      ...(docs.pending_extras
        ? [docs.pending_extras + ' additional-work extra(s) need owner approval before signing.']
        : []),
      ...(docs.company_setup_missing || []).map((text) => 'Company setup required: ' + text),
      ...(docs.unpriced_work || []).map((text) => 'Unpriced work: ' + text),
      ...log
        .filter(({ photo }) => photo.ocr_status === 'pending')
        .map(({ label }) => 'Recognition pending: ' + label),
    ];
    $('auditWarnings').textContent = warnings.join(' · ');
    $('auditWarnings').hidden = !warnings.length;
  }
  // Only the company's own saved logo is shown; there is no built-in company logo.
  function logoFor(identity) {
    return identity?.logo_data_url || '';
  }
  // Documents show the identity saved with them; records saved without one show no company details.
  function brand(docs) {
    const identity = docs.company_identity;
    const name = identity?.name || '';
    document.querySelector('#doc-proposal > h2').textContent = [name, 'Official proposal']
      .filter(Boolean)
      .join(' · ');
    for (const letter of document.querySelectorAll('.document-letterhead')) {
      letter.querySelector('p').textContent = identity
        ? [
            identity.address,
            identity.phone,
            identity.license ? 'CSLB #' + identity.license : 'License not provided',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
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
  root.ADRDocuments = { node, select, render, brand, logoFor, pricedFrom };
})(window);
