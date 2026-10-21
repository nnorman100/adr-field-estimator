/* Psychrometric values and drying-log summaries shared by the UI and the node tests.
   The server computes and stores the same values (backend/psychrometrics.py); this copy only
   shows the technician the result while typing and arranges saved readings by room and day. */
(function (root) {
  // Standard psychrometric equations as ported from DryScope's lib/psychrometrics.ts: Magnus
  // saturation vapor pressure (Bolton 1980 coefficients, Buck's 6.1121 hPa constant), the ASHRAE
  // humidity ratio W = 0.62198·e/(P − e) at 1013.25 hPa with 7000 grains per pound, dew point by
  // inverting Magnus, and enthalpy h = 0.24·t + W·(1061 + 0.444·t) BTU/lb. Pinned values are in
  // tests/test_frontend.js and tests/test_psychrometrics.py.
  const PRESSURE_HPA = 1013.25,
    HPA_TO_INHG = 0.02953;
  const OPTIMAL_GPP = 20,
    ACCEPTABLE_GPP = 12,
    VAPOR_HIGH = 0.25,
    VAPOR_MODERATE = 0.12,
    OPEN_SYSTEM_MARGIN = 20;
  function psychrometrics(tempF, relativeHumidity) {
    const blank = (v) => v === '' || v === null || v === undefined,
      t = blank(tempF) ? NaN : Number(tempF),
      rh = Math.min(100, Math.max(1, blank(relativeHumidity) ? NaN : Number(relativeHumidity)));
    if (!Number.isFinite(t) || !Number.isFinite(rh)) return null;
    const tempC = ((t - 32) * 5) / 9,
      vapor = 6.1121 * Math.exp((17.67 * tempC) / (tempC + 243.5)) * (rh / 100),
      ratio = (0.62198 * vapor) / Math.max(1, PRESSURE_HPA - vapor),
      alpha = Math.log(Math.max(0.001, vapor / 6.1121)),
      dewPointF = Math.round(((243.5 * alpha) / (17.67 - alpha)) * (9 / 5) + 32);
    return {
      gpp: Math.round(ratio * 7000),
      dew_point_f: dewPointF,
      dew_point_depression_f: Math.max(0, Math.round(t - dewPointF)),
      vapor_pressure_inhg: Number((vapor * HPA_TO_INHG).toFixed(3)),
      enthalpy_btu_lb: Number((0.24 * t + ratio * (1061 + 0.444 * t)).toFixed(1)),
    };
  }
  // Dehumidifier grain depression: inlet GPP minus outlet GPP against the IICRC 12/20 marks.
  function grainDepression(inletGpp, outletGpp) {
    const delta = Math.round(inletGpp - outletGpp);
    const status =
      delta >= OPTIMAL_GPP
        ? 'optimal'
        : delta >= ACCEPTABLE_GPP
          ? 'acceptable'
          : delta > 0
            ? 'low'
            : 'none';
    return {
      delta_gpp: delta,
      status,
      efficiency_percent:
        delta <= 0 ? 0 : Math.min(100, Math.round((delta / Math.max(1, inletGpp)) * 100)),
    };
  }
  function vaporPressureDifferential(affectedInHg, outletInHg) {
    const delta = Number((affectedInHg - outletInHg).toFixed(3));
    return {
      delta_inhg: delta,
      potential:
        delta >= VAPOR_HIGH
          ? 'high'
          : delta >= VAPOR_MODERATE
            ? 'moderate'
            : delta > 0
              ? 'low'
              : 'stagnant',
    };
  }
  const dryingSystem = (outsideGpp, affectedGpp) =>
    outsideGpp < affectedGpp - OPEN_SYSTEM_MARGIN ? 'open' : 'closed';

  const ZONES = {
    outside: 'Outside air',
    unaffected: 'Dry reference air',
    affected: 'Affected air',
    dehu_inlet: 'Dehumidifier inlet',
    dehu_outlet: 'Dehumidifier outlet',
  };
  const PATTERNS = {
    cold_anomaly: 'cold anomaly',
    thermal_bridge: 'thermal bridge',
    evaporative_cooling: 'evaporative cooling',
  };
  const DEPRESSION = {
    optimal: 'optimal',
    acceptable: 'acceptable',
    low: 'below the 12 GPP mark',
    none: 'no grain depression',
  };
  const pad = (n) => String(n).padStart(2, '0');
  // The technician's calendar day, so a 11 pm and a 1 am reading fall on the days they were taken.
  function localDay(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const byTime = (a, b) =>
    a.taken_at.localeCompare(b.taken_at) ||
    (a.recorded_at || '').localeCompare(b.recorded_at || '');
  /* Arranges a job's readings by room and day for display. Rooms keep the Check Scope order and
     show even without readings; names no current room uses follow; outside and whole-job entries
     (room '') come last. The dry standard for a day is the latest dry-reference air reading taken
     on or before it, from any room; the dehumidifier inlet defaults to the room's affected air. */
  function summarizeLog(readings, rooms, dayOf = localDay) {
    const sorted = [...(readings || [])].sort(byTime),
      days = [...new Set(sorted.map((r) => dayOf(r.taken_at)))].sort(),
      references = sorted.filter((r) => r.kind === 'air' && r.zone === 'unaffected'),
      outsides = sorted.filter((r) => r.kind === 'air' && r.zone === 'outside');
    const latestBefore = (list, day) => list.filter((r) => dayOf(r.taken_at) <= day).at(-1) || null;
    const names = (rooms || []).map((room) => room.name),
      extra = [...new Set(sorted.map((r) => r.room))].filter((n) => n && !names.includes(n)),
      order = [...names, ...extra, ''];
    const groups = order.map((room) => {
      const mine = sorted.filter((r) => r.room === room),
        roomDays = [...new Set(mine.map((r) => dayOf(r.taken_at)))].map((key) => {
          const list = mine.filter((r) => dayOf(r.taken_at) === key),
            air = (zone) => list.filter((r) => r.kind === 'air' && r.zone === zone).at(-1) || null,
            affected = air('affected'),
            outlet = air('dehu_outlet'),
            inlet = air('dehu_inlet') || affected,
            reference = latestBefore(references, key),
            outside = latestBefore(outsides, key);
          return {
            key,
            number: days.indexOf(key) + 1,
            readings: list,
            affected,
            reference,
            outside,
            above_standard: affected && reference ? Math.round(affected.gpp - reference.gpp) : null,
            depression: inlet && outlet ? grainDepression(inlet.gpp, outlet.gpp) : null,
            vapor:
              affected && outlet
                ? vaporPressureDifferential(
                    affected.vapor_pressure_inhg,
                    outlet.vapor_pressure_inhg,
                  )
                : null,
            system: affected && outside ? dryingSystem(outside.gpp, affected.gpp) : null,
          };
        });
      const tracked = roomDays.filter((d) => d.affected),
        first = tracked[0],
        latest = tracked.at(-1);
      let progress = null;
      if (first && latest && latest.reference) {
        const span = first.affected.gpp - latest.reference.gpp;
        progress = {
          first_gpp: first.affected.gpp,
          latest_gpp: latest.affected.gpp,
          reference_gpp: latest.reference.gpp,
          percent:
            span <= 0
              ? latest.affected.gpp <= latest.reference.gpp
                ? 100
                : 0
              : Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(((first.affected.gpp - latest.affected.gpp) / span) * 100),
                  ),
                ),
          days: tracked.length,
        };
      }
      return {
        room,
        known: names.includes(room),
        days: roomDays,
        progress,
        count: mine.length,
      };
    });
    return { days, groups: groups.filter((g) => g.known || g.count) };
  }
  const api = {
    psychrometrics,
    grainDepression,
    vaporPressureDifferential,
    dryingSystem,
    summarizeLog,
    localDay,
    ZONES,
    PATTERNS,
    DEPRESSION,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ADRPsychro = api;
})(typeof window === 'undefined' ? globalThis : window);
