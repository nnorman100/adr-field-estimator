// Documents as the server writes them for a company price table (dryscope-v2), laid over a real
// audit response. The audit route cannot price a table until the engine and the estimator screens
// land, so these specs route the document body and drive the real pages that render it.
const END = (extra) => ({
  after_hours: 0,
  minimum_adjustment: 0,
  overhead_profit: 0,
  tax: 0,
  ...extra,
});

const LOW = END({
  subtotal: 6640,
  after_hours: 1030,
  overhead_profit: 767,
  tax: 52.8,
  total: 8489.8,
});
const HIGH = END({
  subtotal: 9215,
  after_hours: 1545,
  overhead_profit: 1076,
  tax: 60,
  total: 11896,
});

function line(code, description, quantity, unit, unit_price, total, extra = {}) {
  return { code, description, quantity, unit, unit_price, waste_percent: 0, total, ...extra };
}

function v2Documents(documents, mode = 'range', { breakdown = false } = {}) {
  const range = mode === 'range';
  const proposal = {
    ...documents.adr_estimate,
    proposed_cost: range ? HIGH.total : LOW.total,
    estimate_mode: mode,
  };
  if (range) proposal.proposed_cost_low = LOW.total;
  else delete proposal.proposed_cost_low;
  return {
    ...documents,
    adr_estimate: proposal,
    xactimate_total: LOW.total,
    price_basis: { ...documents.price_basis, sequence: 4, calculation_version: 'dryscope-v2' },
    xactimate_scope: [
      line('SVC', 'Emergency service call', 1, 'each', 150, 150, {
        item_id: 'service_call',
        group: 'job_charges',
        bucket: 'fixed',
        taxable: false,
      }),
      line('DEMO3W', 'Kitchen: Category 3 or mold drywall and trim removal', 300, 'sf', 16, 4800, {
        item_id: 'demo_cat3_wall',
        group: 'demolition',
        bucket: 'labor_material',
        taxable: false,
        xactimate_code: 'WTR DMO',
        room: 'Kitchen',
      }),
      line('FAN', 'Air mover', 6, 'unit_day', 30, 180, {
        item_id: 'air_mover',
        group: 'drying_equipment',
        bucket: 'equipment',
        taxable: true,
      }),
    ],
    estimate: {
      calculation_version: 'dryscope-v2',
      mode,
      low: LOW,
      ...(range ? { high: HIGH } : {}),
      labor_material_low: 5150,
      labor_material_high: 7725,
      after_hours_label: 'After-hours adjustment',
      after_hours_percent: '20',
      overhead_profit_percent: '10',
      sales_tax_percent: '8',
      minimum_job_charge: '0',
      range_rule: { first_sf: 1000, first_percent: '50', beyond_percent: '20' },
      explanation: range
        ? 'The low amount is the itemized total. The high amount adds an allowance to labor and materials for conditions found during the work.'
        : 'The price covers the itemized scope below.',
      show_line_breakdown: breakdown,
    },
    quantity_notes: [
      {
        item: 'demo_cat3_wall',
        label: 'Category 3 or mold drywall and trim removal',
        room: 'Kitchen',
        measured: 320,
        entered: 300,
        reason: 'Closet not wet',
      },
    ],
  };
}

// Replace the documents in a JSON response from the real server, leaving everything else as sent.
function routeDocuments(target, pattern, mode, options) {
  return target.route(pattern, async (route) => {
    if (route.request().method() !== 'GET' && !/\/api\/audit$/.test(route.request().url()))
      return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.audit) body.audit.documents = v2Documents(body.audit.documents, mode, options);
    else if (body.documents) body.documents = v2Documents(body.documents, mode, options);
    await route.fulfill({ response, json: body });
  });
}

module.exports = { v2Documents, routeDocuments };
