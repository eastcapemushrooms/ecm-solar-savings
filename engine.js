/* ECM solar savings engine.
 *
 * Prices half-hourly energy the way NMBM bills tariff 34X_LV_TOU, and works out
 * savings, payback, NPV and IRR. Runs in the browser (window.Engine) and in Node
 * (module.exports) so it can be tested against real invoices.
 *
 * Conventions (verified against the Aug-2026 and Sep-2026 invoices):
 *  - Interval timestamps are the END of each 30-minute interval ("14:00" = 13:30-14:00).
 *  - All times are SAST (UTC+2, no daylight saving).
 *  - Demand = highest 30-minute kVA in the month, at any hour:
 *      kVA = sqrt(kWh^2 + kvarh^2) / 0.5
 *  - TOU periods are the current Eskom-style definitions, NOT the 2022/23 tariff book.
 */
(function (root) {
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const MIN_LOAD_COVERAGE = 0.85;
  const SAST_MS = 2 * 60 * 60 * 1000;

  // Public holidays and how they are billed. Women's Day (10 Aug 2026) and
  // Heritage Day (24 Sep 2026) are confirmed from invoices as Saturday.
  // The others follow Eskom's usual treatment - the monthly billing check on the
  // dashboard will show a mismatch if NMBM treats one differently.
  const HOLIDAYS = {
    '2026-01-01': 'sun', '2026-04-03': 'sun', '2026-04-06': 'sat', '2026-04-27': 'sat',
    '2026-05-01': 'sat', '2026-06-16': 'sat', '2026-08-10': 'sat', '2026-09-24': 'sat',
    '2026-12-16': 'sat', '2026-12-25': 'sun', '2026-12-26': 'sat',
    '2027-01-01': 'sun', '2027-03-22': 'sat', '2027-03-26': 'sun', '2027-03-29': 'sat',
    '2027-04-27': 'sat', '2027-06-16': 'sat', '2027-08-09': 'sat', '2027-09-24': 'sat',
    '2027-12-16': 'sat', '2027-12-25': 'sun', '2027-12-27': 'sat',
    '2028-01-01': 'sat', '2028-03-21': 'sat', '2028-04-14': 'sun', '2028-04-17': 'sat',
    '2028-04-27': 'sat', '2028-05-01': 'sat', '2028-06-16': 'sat', '2028-08-09': 'sat',
    '2028-09-25': 'sat', '2028-12-16': 'sat', '2028-12-25': 'sun', '2028-12-26': 'sat',
  };

  // [start hour, end hour) in SAST, by the START of the interval.
  const PERIODS = {
    winter: {
      wk: { peak: [[6, 8], [17, 20]], std: [[8, 17], [20, 22]] },
      sat: { std: [[7, 12], [17, 19]] },
      sun: { std: [[17, 19]] },
    },
    summer: {
      wk: { peak: [[7, 9], [17, 20]], std: [[6, 7], [9, 17], [20, 22]] },
      sat: { std: [[7, 12], [18, 20]] },
      sun: { std: [[18, 20]] },
    },
  };

  /** SAST calendar fields for a UTC instant. */
  function sast(date) {
    const d = new Date(date.getTime() + SAST_MS);
    return {
      y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      dow: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60,
      iso: d.toISOString().slice(0, 10),
    };
  }

  function season(month) { return month >= 6 && month <= 8 ? 'winter' : 'summer'; }

  function dayType(s) {
    if (HOLIDAYS[s.iso]) return HOLIDAYS[s.iso];
    if (s.dow === 0) return 'sun';
    if (s.dow === 6) return 'sat';
    return 'wk';
  }

  /** TOU period for an interval identified by its END time. */
  function touPeriod(tsEnd) {
    const s = sast(new Date(tsEnd.getTime() - HALF_HOUR_MS));
    const def = PERIODS[season(s.m)][dayType(s)];
    const inside = (ranges) => (ranges || []).some(([a, b]) => s.hour >= a && s.hour < b);
    if (inside(def.peak)) return 'peak';
    if (inside(def.std)) return 'std';
    return 'off';
  }

  /** Billing month key "YYYY-MM" (SAST) for an interval END time. */
  function monthKey(tsEnd) {
    const s = sast(new Date(tsEnd.getTime() - HALF_HOUR_MS));
    return `${s.y}-${String(s.m).padStart(2, '0')}`;
  }

  /**
   * Price a month of intervals.
   * intervals: [{tsEnd: Date, kwh: number, kvarh: number}]
   * rates: {winter:{peak,std,off}, summer:{peak,std,off}} in c/kWh, demand R/kVA, basic R
   */
  function priceMonth(intervals, rates, month) {
    const kwh = { peak: 0, std: 0, off: 0 };
    let maxKva = 0, maxAt = null;
    for (const iv of intervals) {
      kwh[touPeriod(iv.tsEnd)] += iv.kwh;
      const kva = Math.sqrt(iv.kwh * iv.kwh + iv.kvarh * iv.kvarh) / 0.5;
      if (kva > maxKva) { maxKva = kva; maxAt = iv.tsEnd; }
    }
    const r = rates[season(Number(month.slice(5, 7)))];
    const energyR = (kwh.peak * r.peak + kwh.std * r.std + kwh.off * r.off) / 100;
    const demandR = maxKva * rates.demand;
    return {
      kwh, kwhTotal: kwh.peak + kwh.std + kwh.off, maxKva, maxAt,
      energyR, demandR, basicR: rates.basic,
      total: energyR + demandR + rates.basic,
    };
  }

  /** Every interval-end time in a month (SAST). */
  function monthSlots(month) {
    const [y, m] = month.split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1) - SAST_MS + HALF_HOUR_MS;
    const end = Date.UTC(y, m, 1) - SAST_MS;
    const out = [];
    for (let t = start; t <= end; t += HALF_HOUR_MS) out.push(t);
    return out;
  }

  /**
   * Build the month's view.
   * grid: Map<ms, {kwh, kvarh}> from NMBM (what was actually billed)
   * abb:  Map<ms, {kwh, kvarh, quality}> farm load from the ABB (after the rewire)
   * abbLoadFrom: ms from which the ABB measures farm load (null = not yet)
   * abbFactor: calibration factor applied to ABB energy
   */
  function analyseMonth({ month, grid, abb, abbLoadFrom, abbFactor = 1, rates, invoiceTotal }) {
    const slots = monthSlots(month);
    const actualIv = [], baselineIv = [];
    let gridSlots = 0, loadSlots = 0, estimated = 0, filled = 0;
    for (const t of slots) {
      const g = grid.get(t);
      const a = abbLoadFrom != null && t > abbLoadFrom ? abb.get(t) : undefined;
      if (g) { gridSlots++; actualIv.push({ tsEnd: new Date(t), kwh: g.kwh, kvarh: g.kvarh }); }
      if (a) {
        loadSlots++;
        if (a.quality && a.quality !== 'ok') estimated++;
        baselineIv.push({ tsEnd: new Date(t), kwh: a.kwh * abbFactor, kvarh: a.kvarh * abbFactor });
      } else if (g && !solarExpected(t)) {
        // Before solar existed, the grid WAS the load.
        loadSlots++;
        baselineIv.push({ tsEnd: new Date(t), kwh: g.kwh, kvarh: g.kvarh });
      } else if (g) {
        // No farm-load reading (before the rewire, or logger offline): fall back to
        // the grid figure. That assumes zero solar for the interval, so savings are
        // understated, never overstated.
        filled++;
        baselineIv.push({ tsEnd: new Date(t), kwh: g.kwh, kvarh: g.kvarh });
      }
    }
    const n = slots.length;
    const actualCalc = gridSlots ? priceMonth(actualIv, rates, month) : null;
    const baseline = loadSlots + filled ? priceMonth(baselineIv, rates, month) : null;
    const actual = invoiceTotal != null ? invoiceTotal : actualCalc ? actualCalc.total : null;
    // A month counts when every interval has a baseline value, at least 85% of them
    // from real farm-load data, and the actual bill is known.
    const complete = loadSlots + filled === n && loadSlots / n >= MIN_LOAD_COVERAGE
      && (invoiceTotal != null || gridSlots === n);
    return {
      month, slots: n, gridCoverage: gridSlots / n, loadCoverage: loadSlots / n,
      filledShare: filled / n,
      estimatedShare: loadSlots ? estimated / loadSlots : 0,
      actualCalc, baseline, actual, invoiceTotal,
      savings: complete && baseline ? baseline.total - actual : null,
      energySavings: complete && baseline && actualCalc ? baseline.energyR - actualCalc.energyR : null,
      demandSavings: complete && baseline && actualCalc ? baseline.demandR - actualCalc.demandR : null,
      complete,
    };
  }

  // Set by the app: the solar commissioning instant (ms). Grid-only intervals
  // after this cannot stand in for load.
  let commissionMs = Infinity;
  function solarExpected(t) { return t > commissionMs; }
  function setCommission(ms) { commissionMs = ms; }

  /* ---------- Finance ---------- */

  function npv(rateMonthly, flows) {
    return flows.reduce((acc, f, i) => acc + f / Math.pow(1 + rateMonthly, i), 0);
  }

  /** Monthly IRR by bisection; flows[0] is the (negative) investment. */
  function irrMonthly(flows) {
    let lo = -0.99, hi = 1;
    if (npv(lo, flows) * npv(hi, flows) > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (npv(mid, flows) > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Project the investment.
   * actualSavings: [number] completed months in order, starting with the commissioning month
   * Projection repeats the average of the actual months, escalated yearly and degraded.
   */
  function finance({ capex, actualSavings, discountRate, escalation, degradation, lifeYears }) {
    const months = lifeYears * 12;
    const avg = actualSavings.length
      ? actualSavings.reduce((a, b) => a + b, 0) / actualSavings.length : 0;
    const flows = [-capex];
    for (let i = 0; i < months; i++) {
      if (i < actualSavings.length) { flows.push(actualSavings[i]); continue; }
      const yr = Math.floor(i / 12);
      flows.push(avg * Math.pow(1 + escalation, yr) * Math.pow(1 - degradation, yr));
    }
    const rM = Math.pow(1 + discountRate, 1 / 12) - 1;
    let cum = -capex, cumDisc = -capex, payback = null, paybackDisc = null;
    for (let i = 1; i < flows.length; i++) {
      cum += flows[i];
      cumDisc += flows[i] / Math.pow(1 + rM, i);
      if (payback == null && cum >= 0) payback = i / 12;
      if (paybackDisc == null && cumDisc >= 0) paybackDisc = i / 12;
    }
    const irrM = avg > 0 ? irrMonthly(flows) : null;
    return {
      avgMonthly: avg,
      cumulativeActual: actualSavings.reduce((a, b) => a + b, 0),
      paybackYears: payback, paybackDiscYears: paybackDisc,
      npv: npv(rM, flows),
      irr: irrM == null ? null : Math.pow(1 + irrM, 12) - 1,
      flows,
    };
  }

  const api = { touPeriod, monthKey, priceMonth, monthSlots, analyseMonth, finance,
    setCommission, sast, HALF_HOUR_MS, SAST_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
