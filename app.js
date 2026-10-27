/* ECM Solar Savings dashboard. Data lives in Supabase; all calculations run here
 * with engine.js so every number can be traced back to half-hourly data. */
(function () {
  'use strict';
  const E = window.Engine, P = window.Parsers;
  const HH = E.HALF_HOUR_MS, SAST = E.SAST_MS;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ------------------------------------------------------------ data layer */

  function supabaseDb() {
    const cfg = window.ECM_CONFIG || {};
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR-PROJECT')) {
      throw new Error('config.js is not filled in yet (Supabase URL and anon key).');
    }
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    async function all(table, order) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) return out;
      }
    }
    return {
      async session() { return (await sb.auth.getSession()).data.session; },
      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return data.session;
      },
      async signOut() { await sb.auth.signOut(); },
      async loadAll() {
        const [settings, invoices, nmbm, abb, live] = await Promise.all([
          all('settings', 'key'), all('invoices', 'month'), all('nmbm_intervals', 'ts_end'),
          all('abb_halfhour', 'ts_end'), sb.from('abb_live').select('*').limit(1),
        ]);
        if (live.error) throw live.error;
        return { settings, invoices, nmbm, abb, live: live.data[0] || null };
      },
      async upsert(table, rows, onConflict) {
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict });
          if (error) throw error;
        }
      },
    };
  }

  let db;
  try { db = window.ECM_TEST_DB || supabaseDb(); } catch (e) { db = null; window.__cfgError = e.message; }

  /* ------------------------------------------------------------ formatting */

  const fmtR = (v, dp = 0) => v == null || isNaN(v) ? '—'
    : (v < 0 ? '−R' : 'R') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const fmtAxisR = (v) => { const a = Math.abs(v); return (v < 0 ? '−R' : 'R') + (a >= 1e6 ? (a / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'm' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : a); };
  const fmtRm = (v) => v == null ? '—' : (v < 0 ? '−' : '') + 'R' + (Math.abs(v) / 1e6).toFixed(2) + 'm';
  const fmtN = (v, dp = 0) => v == null || isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const fmtPct = (v, dp = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(dp) + '%';
  const monthLabel = (m) => new Date(m + '-15T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const sastStr = (ms, opts) => new Date(ms + SAST).toLocaleString('en-GB', { timeZone: 'UTC', ...opts });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ------------------------------------------------------------ state */

  let raw = null, model = null;
  const charts = {};

  function settingsMap(rows) {
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      capex: Number(s.capex ?? 0),
      commissionDate: s.commission_date || null,
      discountRate: Number(s.discount_rate ?? 0.1),
      escalation: Number(s.tariff_escalation ?? 0.09),
      degradation: Number(s.degradation ?? 0.005),
      lifeYears: Number(s.life_years ?? 25),
      abbLoadFrom: s.abb_load_from ? Date.parse(s.abb_load_from) : null,
      abbFactor: Number(s.abb_factor ?? 1),
    };
  }

  function buildModel(r) {
    const st = settingsMap(r.settings);
    const commissionMs = st.commissionDate ? Date.parse(st.commissionDate + 'T00:00:00Z') - SAST : Infinity;
    E.setCommission(commissionMs);
    const commissionMonth = st.commissionDate ? st.commissionDate.slice(0, 7) : null;

    const grid = new Map(r.nmbm.map((x) => [Date.parse(x.ts_end), { kwh: x.kw * 0.5, kvarh: x.kvar * 0.5 }]));
    const abb = new Map(r.abb.map((x) => [Date.parse(x.ts_end), {
      kwh: Number(x.kwh_imp) - Number(x.kwh_exp),
      kvarh: Math.abs(Number(x.kvarh_imp) - Number(x.kvarh_exp)),
      quality: x.quality,
    }]));
    const invoices = Object.fromEntries(r.invoices.map((i) => [i.month.slice(0, 7), i]));

    // Months to show: from the first data we have to the current month.
    const keys = [...grid.keys(), ...abb.keys()].map((t) => E.monthKey(new Date(t)))
      .concat(Object.keys(invoices));
    const now = E.monthKey(new Date(Date.now() + HH));
    keys.sort();
    const first = keys.length ? keys[0] : now;
    const last = keys.length && keys[keys.length - 1] > now ? keys[keys.length - 1] : now;
    const months = [];
    for (let m = first; m <= last;) {
      months.push(m);
      const [y, mo] = m.split('-').map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }

    const latestRates = (m) => {
      const ks = Object.keys(invoices).filter((k) => k <= m).sort();
      const k = ks.length ? ks[ks.length - 1] : Object.keys(invoices).sort()[0];
      return k ? invoices[k].rates : null;
    };

    const rows = months.map((m) => {
      const rates = invoices[m] ? invoices[m].rates : latestRates(m);
      const pre = commissionMonth ? m < commissionMonth : true;
      if (!rates) return { month: m, pre, noRates: true };
      const a = E.analyseMonth({
        month: m, grid, abb, abbLoadFrom: st.abbLoadFrom, abbFactor: st.abbFactor, rates,
        invoiceTotal: invoices[m] ? Number(invoices[m].total_excl_vat) : null,
      });
      return { ...a, pre, invoice: invoices[m] || null };
    });

    const done = rows.filter((x) => !x.pre && x.complete);
    const fin = E.finance({
      capex: st.capex, actualSavings: done.map((x) => x.savings),
      discountRate: st.discountRate, escalation: st.escalation,
      degradation: st.degradation, lifeYears: st.lifeYears,
    });
    return { st, grid, abb, invoices, months, rows, done, fin, commissionMonth };
  }

  /* ------------------------------------------------------------ charts */

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function chart(id, cfg) {
    setEmpty(id, null);
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }
  /** Show a message instead of a chart (msg = null to show the chart again). */
  function setEmpty(id, msg) {
    const canvas = document.getElementById(id), box = canvas.parentElement;
    let note = box.querySelector('.empty');
    if (msg == null) { canvas.classList.remove('hidden'); if (note) note.remove(); return; }
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    canvas.classList.add('hidden');
    if (!note) { note = document.createElement('div'); note.className = 'empty'; box.appendChild(note); }
    note.textContent = msg;
  }
  function baseOptions(yTitle, yFmt, axisFmt = yFmt) {
    const text2 = css('--text-2'), border = css('--border');
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text'),
          borderColor: border, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: { label: (c) => ` ${c.dataset.label}: ${c.raw == null ? '—' : yFmt(c.raw)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: text2, maxRotation: 0, autoSkipPadding: 12 }, border: { color: border } },
        y: {
          beginAtZero: true, grid: { color: border }, border: { display: false },
          ticks: { color: text2, callback: (v) => axisFmt(v) }, title: { display: !!yTitle, text: yTitle, color: text2 },
        },
      },
    };
  }
  const line = (label, data, color, extra = {}) => ({
    label, data, borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: false, ...extra,
  });

  /* ------------------------------------------------------------ overview */

  function renderStatus() {
    const el = $('#status'), live = raw.live, st = model.st;
    const parts = [];
    if (live) {
      const age = (Date.now() - Date.parse(live.ts)) / 60000;
      const [c, word] = age < 5 ? ['var(--good)', 'Live'] : age < 60 ? ['var(--warn)', 'Delayed'] : ['var(--bad)', 'Offline'];
      parts.push(`<span class="pill"><span class="dot" style="background:${c}"></span>ABB logger: <b>${word}</b> · ${live.kw != null ? fmtN(Number(live.kw), 0) + ' kW' : '—'} · last reading ${sastStr(Date.parse(live.ts), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>`);
    } else {
      parts.push('<span class="pill"><span class="dot" style="background:var(--bad)"></span>ABB logger: <b>no data yet</b></span>');
    }
    parts.push(st.abbLoadFrom
      ? `<span>ABB measures farm load since ${sastStr(st.abbLoadFrom, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
      : '<span>ABB still measures grid supply. After the solar tie-in is moved, set the time in Settings.</span>');
    const lastN = raw.nmbm.length ? raw.nmbm[raw.nmbm.length - 1].ts_end : null;
    parts.push(`<span>NMBM data to ${lastN ? sastStr(Date.parse(lastN) - HH, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>`);
    el.innerHTML = parts.join('');
  }

  function renderKpis() {
    const { done, fin, st } = model;
    const last = done[done.length - 1];
    const none = 'Needs the first full month of farm-load data and its invoice';
    const tiles = [
      ['Savings, last full month', last ? fmtR(last.savings) : '—',
        last ? `${monthLabel(last.month)} · energy ${fmtR(last.energySavings)}, demand ${fmtR(last.demandSavings)}` : none],
      ['Cumulative savings', done.length ? fmtR(fin.cumulativeActual) : '—',
        done.length ? `${fmtPct(fin.cumulativeActual / st.capex)} of installed cost recovered` : none],
      ['Payback (projected)', fin.paybackYears != null ? fin.paybackYears.toFixed(1) + ' years' : '—',
        fin.paybackDiscYears != null ? `Discounted at ${fmtPct(st.discountRate, 0)}: ${fin.paybackDiscYears.toFixed(1)} years` : none],
      ['IRR (projected)', fin.irr != null ? fmtPct(fin.irr) : '—',
        fin.irr != null ? `NPV at ${fmtPct(st.discountRate, 0)}: ${fmtRm(fin.npv)}` : none],
      ['Installed cost', fmtRm(st.capex), st.commissionDate ? `Commissioned ${new Date(st.commissionDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''],
    ];
    $('#kpis').innerHTML = tiles.map(([l, v, n]) =>
      `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${esc(n)}</div></div>`).join('')
      + (done.length ? `<div class="note" style="grid-column:1/-1;color:var(--muted);font-size:12px">Projection repeats the average of ${done.length} full month${done.length > 1 ? 's' : ''} (${fmtR(fin.avgMonthly)}/month), rising ${fmtPct(st.escalation, 0)} a year with tariffs, less ${fmtPct(st.degradation, 1)} a year PV degradation, over ${st.lifeYears} years.${done.length < 12 ? ' Until there are 12 months, seasonal swings make this a rough guide.' : ''}</div>` : '');
  }

  function renderMonthlyChart() {
    const shownActual = (r) => (r.invoiceTotal != null ? r.invoiceTotal : r.gridCoverage === 1 && r.actualCalc ? r.actualCalc.total : null);
    const rows = model.rows.filter((r) => shownActual(r) != null || (!r.pre && r.complete));
    if (!rows.length) { setEmpty('chMonthly', 'No bills yet.'); return; }
    const o = baseOptions('', (v) => fmtR(v), fmtAxisR);
    o.datasets = { bar: { borderRadius: 4, borderSkipped: 'bottom', categoryPercentage: 0.7, barPercentage: 0.9 } };
    chart('chMonthly', {
      type: 'bar',
      data: {
        labels: rows.map((r) => monthLabel(r.month)),
        datasets: [
          { label: 'Without solar', data: rows.map((r) => (!r.pre && r.complete && r.baseline ? r.baseline.total : null)), backgroundColor: css('--s-load') },
          { label: 'Actual NMBM bill', data: rows.map(shownActual), backgroundColor: css('--s-grid') },
        ],
      },
      options: o,
    });
  }

  function renderCumulativeChart() {
    const { fin, done, st, commissionMonth } = model;
    if (!done.length) { setEmpty('chCumulative', 'Appears after the first full month of savings.'); return; }
    const horizon = Math.min(fin.flows.length - 1, Math.max(done.length + 12, Math.ceil(((fin.paybackYears || 8) + 1.5) * 12)));
    const labels = [], act = [], proj = [], cap = [];
    let cum = 0;
    const [y0, m0] = commissionMonth.split('-').map(Number);
    for (let i = 1; i <= horizon; i++) {
      cum += fin.flows[i];
      const d = new Date(Date.UTC(y0, m0 - 1 + i - 1, 15));
      labels.push(d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
      act.push(i <= done.length ? cum : null);
      proj.push(i >= done.length ? cum : null);
      cap.push(st.capex);
    }
    chart('chCumulative', {
      type: 'line',
      data: {
        labels,
        datasets: [
          line('Actual', act, css('--s-solar'), { pointRadius: 3 }),
          line('Projected', proj, css('--s-solar'), { borderDash: [6, 4] }),
          line('Installed cost', cap, css('--s-ref'), { borderDash: [3, 3], borderWidth: 1.5, tension: 0 }),
        ],
      },
      options: baseOptions('', (v) => fmtR(v), fmtAxisR),
    });
  }

  function renderMonthTable() {
    const head = ['Month', 'NMBM invoice', 'Our calc', 'Difference', 'Without solar', 'Savings', 'Energy', 'Demand', 'Max kVA (actual / without)', 'Farm-load data', 'Notes'];
    const body = model.rows.slice().reverse().map((r) => {
      if (r.noRates) return `<tr><td>${monthLabel(r.month)}</td>${'<td>—</td>'.repeat(9)}<td class="wrapcell">Upload an invoice so the tariff rates are known.</td></tr>`;
      const calc = r.actualCalc ? r.actualCalc.total : null;
      const diff = calc != null && r.invoiceTotal != null ? calc - r.invoiceTotal : null;
      const notes = [];
      if (r.pre) notes.push('Before solar - billing check only');
      if (!r.invoiceTotal) notes.push('Invoice not uploaded');
      if (r.gridCoverage < 1) notes.push(`NMBM data ${fmtPct(r.gridCoverage, 0)}`);
      if (!r.pre && r.loadCoverage === 0) notes.push('No farm-load data yet (ABB not measuring load)');
      else if (!r.pre && !r.complete && r.loadCoverage < 0.85) notes.push(`Only ${fmtPct(r.loadCoverage, 0)} farm-load data - needs 85%`);
      if (!r.pre && r.complete && r.filledShare > 0) notes.push(`${fmtPct(r.filledShare, 1)} of intervals had no farm-load reading and count as zero solar (savings understated)`);
      if (r.estimatedShare > 0) notes.push(`${fmtPct(r.estimatedShare, 1)} of intervals estimated (logger offline)`);
      const show = !r.pre && r.complete;
      return `<tr>
        <td>${monthLabel(r.month)}</td>
        <td>${fmtR(r.invoiceTotal)}</td>
        <td>${calc != null ? fmtR(calc) : '—'}</td>
        <td>${diff != null ? `${fmtR(diff)} (${fmtPct(diff / r.invoiceTotal, 2)})` : '—'}</td>
        <td>${show ? fmtR(r.baseline.total) : '—'}</td>
        <td class="${show && r.savings > 0 ? 'pos' : ''}">${show ? fmtR(r.savings) : '—'}</td>
        <td>${show ? fmtR(r.energySavings) : '—'}</td>
        <td>${show ? fmtR(r.demandSavings) : '—'}</td>
        <td>${r.actualCalc ? fmtN(r.actualCalc.maxKva, 1) : '—'} / ${show ? fmtN(r.baseline.maxKva, 1) : '—'}</td>
        <td>${r.pre ? 'n/a' : fmtPct(r.loadCoverage, 0)}</td>
        <td class="wrapcell">${esc(notes.join(' · '))}</td></tr>`;
    }).join('');
    $('#monthTable').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
  }

  /* ------------------------------------------------------------ energy tab */

  function loadAt(t) {
    // Farm load for an interval: ABB after the rewire, NMBM grid before solar existed.
    const { st, abb, grid } = model;
    if (st.abbLoadFrom != null && t > st.abbLoadFrom) {
      const a = abb.get(t);
      return a ? a.kwh * st.abbFactor : null;
    }
    const commissionMs = model.commissionMonth ? Date.parse(model.st.commissionDate + 'T00:00:00Z') - SAST : Infinity;
    if (t <= commissionMs) { const g = grid.get(t); return g ? g.kwh : null; }
    return null;
  }

  function renderEnergy() {
    const sel = $('#selMonth');
    if (!sel.options.length) {
      sel.innerHTML = model.months.slice().reverse().map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    }
    const month = sel.value;
    const slots = E.monthSlots(month);
    const days = [...new Set(slots.map((t) => E.sast(new Date(t - HH)).iso))];
    const daySel = $('#selDay');
    if (daySel.dataset.month !== month) {
      daySel.dataset.month = month;
      const withData = days.filter((d) => slots.some((t) => E.sast(new Date(t - HH)).iso === d && (loadAt(t) != null || model.grid.get(t))));
      daySel.innerHTML = days.map((d) => `<option value="${d}">${new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</option>`).join('');
      daySel.value = withData.length ? withData[withData.length - 1] : days[0];
    }

    const per = days.map((d) => ({ d, load: 0, grid: 0, solar: 0, nl: 0, ng: 0, ns: 0 }));
    const idx = Object.fromEntries(days.map((d, i) => [d, i]));
    for (const t of slots) {
      const p = per[idx[E.sast(new Date(t - HH)).iso]];
      const l = loadAt(t), g = model.grid.get(t);
      if (l != null) { p.load += l; p.nl++; }
      if (g) { p.grid += g.kwh; p.ng++; }
      if (l != null && g && t > (Date.parse(model.st.commissionDate + 'T00:00:00Z') - SAST)) { p.solar += Math.max(0, l - g.kwh); p.ns++; }
    }
    chart('chDaily', {
      type: 'line',
      data: {
        labels: per.map((p) => Number(p.d.slice(8))),
        datasets: [
          line('Farm load', per.map((p) => (p.nl === 48 ? p.load : null)), css('--s-load'), { pointRadius: 2 }),
          line('Grid import', per.map((p) => (p.ng === 48 ? p.grid : null)), css('--s-grid'), { pointRadius: 2 }),
          line('Solar', per.map((p) => (p.ns === 48 ? p.solar : null)), css('--s-solar'), { pointRadius: 2 }),
        ],
      },
      options: (() => { const o = baseOptions('kWh per day', (v) => fmtN(v, 0)); o.plugins.tooltip.callbacks.title = (c) => `${c[0].label} ${monthLabel(month)}`; return o; })(),
    });

    const day = daySel.value;
    const daySlots = slots.filter((t) => E.sast(new Date(t - HH)).iso === day);
    const commissionMs = Date.parse(model.st.commissionDate + 'T00:00:00Z') - SAST;
    chart('chDay', {
      type: 'line',
      data: {
        labels: daySlots.map((t) => sastStr(t, { hour: '2-digit', minute: '2-digit' })),
        datasets: [
          line('Farm load', daySlots.map((t) => { const l = loadAt(t); return l == null ? null : l * 2; }), css('--s-load')),
          line('Grid import', daySlots.map((t) => { const g = model.grid.get(t); return g ? g.kwh * 2 : null; }), css('--s-grid')),
          line('Solar', daySlots.map((t) => { const l = loadAt(t), g = model.grid.get(t); return l != null && g && t > commissionMs ? Math.max(0, l - g.kwh) * 2 : null; }), css('--s-solar')),
        ],
      },
      options: (() => { const o = baseOptions('kW', (v) => fmtN(v, 0)); o.plugins.tooltip.callbacks.title = (c) => `Interval ending ${c[0].label}`; return o; })(),
    });
    renderCalibration();
  }

  function renderCalibration() {
    const { abb, grid, st } = model;
    const byDay = {};
    let sa = 0, sg = 0, n = 0, maxA = 0, maxG = 0;
    for (const [t, a] of abb) {
      if (st.abbLoadFrom != null && t > st.abbLoadFrom) continue;
      const g = grid.get(t);
      if (!g || a.quality !== 'ok') continue;
      const d = E.sast(new Date(t - HH)).iso;
      byDay[d] = byDay[d] || { a: 0, g: 0, n: 0 };
      byDay[d].a += a.kwh; byDay[d].g += g.kwh; byDay[d].n++;
      sa += a.kwh; sg += g.kwh; n++;
      maxA = Math.max(maxA, Math.hypot(a.kwh, a.kvarh) * 2);
      maxG = Math.max(maxG, Math.hypot(g.kwh, g.kvarh) * 2);
    }
    const el = $('#calib');
    if (!n) {
      el.innerHTML = '<div class="empty">No overlap yet. It appears once the ABB has logged some days before the rewire and the NMBM data for those days has been uploaded.</div>';
      return;
    }
    const factor = sg / sa;
    el.innerHTML = `<p>Over ${n} matching half-hours, NMBM recorded <b>${fmtN(sg, 0)} kWh</b> and the ABB <b>${fmtN(sa, 0)} kWh</b>.
      Calibration factor (NMBM ÷ ABB): <b>${factor.toFixed(4)}</b>. Highest kVA: NMBM ${fmtN(maxG, 1)}, ABB ${fmtN(maxA, 1)}.</p>
      <div class="scroll"><table><thead><tr><th>Day</th><th>Half-hours</th><th>NMBM kWh</th><th>ABB kWh</th><th>Ratio</th></tr></thead><tbody>
      ${Object.entries(byDay).map(([d, v]) => `<tr><td>${d}</td><td>${v.n}</td><td>${fmtN(v.g, 1)}</td><td>${fmtN(v.a, 1)}</td><td>${(v.g / v.a).toFixed(4)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="secondary" id="useFactor">Use factor ${factor.toFixed(4)}</button><span class="sub" style="color:var(--text-2);font-size:13px">Currently ${st.abbFactor.toFixed(4)}</span></div>`;
    $('#useFactor').onclick = async () => {
      await db.upsert('settings', [{ key: 'abb_factor', value: Number(factor.toFixed(4)) }], 'key');
      await refresh();
    };
  }

  /* ------------------------------------------------------------ upload tab */

  let pendingProfile = null;
  $('#fileProfile').addEventListener('change', async (ev) => {
    const out = $('#profilePreview'); pendingProfile = null; $('#saveProfile').disabled = true;
    out.className = 'msg'; out.textContent = 'Reading…';
    try {
      const f = ev.target.files[0];
      const wb = XLSX.read(await f.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      const iv = P.parseProfileRows(rows);
      const kwh = iv.reduce((a, x) => a + x.kw * 0.5, 0);
      const kva = Math.max(...iv.map((x) => Math.hypot(x.kw, x.kvar)));
      const months = [...new Set(iv.map((x) => E.monthKey(new Date(x.ts_end))))].map(monthLabel).join(', ');
      pendingProfile = iv;
      out.className = 'msg ok';
      out.textContent = `${iv.length} half-hours (${months}) · ${fmtN(kwh, 2)} kWh · max ${fmtN(kva, 3)} kVA. Check these against the invoice, then save.`;
      $('#saveProfile').disabled = false;
    } catch (e) { out.className = 'msg err'; out.textContent = e.message; }
  });
  $('#saveProfile').addEventListener('click', async () => {
    const out = $('#profilePreview'); $('#saveProfile').disabled = true;
    try {
      await db.upsert('nmbm_intervals', pendingProfile, 'ts_end');
      out.className = 'msg ok'; out.textContent = `Saved ${pendingProfile.length} half-hours.`;
      pendingProfile = null; $('#fileProfile').value = '';
      await refresh();
    } catch (e) { out.className = 'msg err'; out.textContent = 'Save failed: ' + e.message; $('#saveProfile').disabled = false; }
  });

  function fillInvoiceForm(inv) {
    const f = $('#invoiceForm');
    const set = (n, v) => { if (v != null) f.elements[n].value = v; };
    set('month', inv.month); set('total_excl_vat', inv.total_excl_vat); set('max_kva', inv.max_kva);
    set('demand', inv.rates.demand); set('basic', inv.rates.basic);
    set('w_peak', inv.rates.winter.peak); set('w_std', inv.rates.winter.std); set('w_off', inv.rates.winter.off);
    set('s_peak', inv.rates.summer.peak); set('s_std', inv.rates.summer.std); set('s_off', inv.rates.summer.off);
  }
  let parsedInvoice = null;
  $('#fileInvoice').addEventListener('change', async (ev) => {
    const msg = $('#invoiceMsg'); msg.className = 'msg'; msg.textContent = 'Reading…';
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await ev.target.files[0].arrayBuffer()) }).promise;
      const tc = await (await doc.getPage(1)).getTextContent();
      parsedInvoice = P.parseInvoiceText(tc.items.map((i) => i.str).join(' '));
      fillInvoiceForm(parsedInvoice);
      msg.className = 'msg ok';
      msg.textContent = `Read ${monthLabel(parsedInvoice.month)}: ${fmtR(parsedInvoice.total_excl_vat, 2)} excl. VAT, ${fmtN(parsedInvoice.kwh_peak + parsedInvoice.kwh_std + parsedInvoice.kwh_off, 2)} kWh. Check the figures, then save.`;
    } catch (e) { msg.className = 'msg err'; msg.textContent = e.message + ' You can type the figures in instead.'; }
  });
  $('#saveInvoice').addEventListener('click', async () => {
    const f = $('#invoiceForm'), msg = $('#invoiceMsg');
    if (!f.reportValidity()) return;
    const v = (n) => (f.elements[n].value === '' ? null : Number(f.elements[n].value));
    const month = f.elements.month.value;
    const row = {
      month: month + '-01', total_excl_vat: v('total_excl_vat'), max_kva: v('max_kva'),
      kwh_peak: parsedInvoice && parsedInvoice.month === month ? parsedInvoice.kwh_peak : null,
      kwh_std: parsedInvoice && parsedInvoice.month === month ? parsedInvoice.kwh_std : null,
      kwh_off: parsedInvoice && parsedInvoice.month === month ? parsedInvoice.kwh_off : null,
      rates: {
        winter: { peak: v('w_peak'), std: v('w_std'), off: v('w_off') },
        summer: { peak: v('s_peak'), std: v('s_std'), off: v('s_off') },
        demand: v('demand'), basic: v('basic'),
      },
      source: parsedInvoice && parsedInvoice.month === month ? parsedInvoice.source : 'manual',
    };
    try {
      await db.upsert('invoices', [row], 'month');
      msg.className = 'msg ok'; msg.textContent = `Saved invoice for ${monthLabel(month)}.`;
      await refresh();
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'Save failed: ' + e.message; }
  });

  /* ------------------------------------------------------------ settings tab */

  function fillSettings() {
    const st = model.st, f = $('#settingsForm');
    f.capex.value = st.capex; f.commission_date.value = st.commissionDate || '';
    f.discount_rate.value = +(st.discountRate * 100).toFixed(2);
    f.tariff_escalation.value = +(st.escalation * 100).toFixed(2);
    f.degradation.value = +(st.degradation * 100).toFixed(2);
    f.life_years.value = st.lifeYears; f.abb_factor.value = st.abbFactor;
    f.abb_load_from.value = st.abbLoadFrom != null ? new Date(st.abbLoadFrom + SAST).toISOString().slice(0, 16) : '';
  }
  $('#saveSettings').addEventListener('click', async () => {
    const f = $('#settingsForm'), msg = $('#settingsMsg');
    const pct = (n) => Number(f[n].value) / 100;
    const from = f.abb_load_from.value ? new Date(Date.parse(f.abb_load_from.value + ':00Z') - SAST).toISOString() : null;
    const rows = [
      ['capex', Number(f.capex.value)], ['commission_date', f.commission_date.value || null],
      ['discount_rate', pct('discount_rate')], ['tariff_escalation', pct('tariff_escalation')],
      ['degradation', pct('degradation')], ['life_years', Number(f.life_years.value)],
      ['abb_load_from', from], ['abb_factor', Number(f.abb_factor.value) || 1],
    ].map(([key, value]) => ({ key, value }));
    try {
      await db.upsert('settings', rows, 'key');
      msg.className = 'msg ok'; msg.textContent = 'Saved.';
      await refresh();
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'Save failed: ' + e.message; }
  });

  /* ------------------------------------------------------------ shell */

  let activeTab = 'overview';
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    $$('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== activeTab));
    renderActive();
  }));
  $('#selMonth').addEventListener('change', renderEnergy);
  $('#selDay').addEventListener('change', renderEnergy);

  function renderActive() {
    if (!model) return;
    if (activeTab === 'overview') { renderKpis(); renderMonthlyChart(); renderCumulativeChart(); renderMonthTable(); }
    if (activeTab === 'energy') renderEnergy();
    if (activeTab === 'settings') fillSettings();
  }

  async function refresh() {
    raw = await db.loadAll();
    model = buildModel(raw);
    window.__model = model;
    renderStatus();
    renderActive();
  }

  async function start() {
    if (!db) {
      $('#login').classList.remove('hidden');
      $('#loginMsg').textContent = window.__cfgError;
      return;
    }
    const session = await db.session();
    if (!session) { $('#login').classList.remove('hidden'); return; }
    $('#userEmail').textContent = session.user ? session.user.email : '';
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    try { await refresh(); } catch (e) { $('#status').innerHTML = `<span class="msg err">Could not load data: ${esc(e.message)}</span>`; }
    setInterval(() => refresh().catch(() => {}), 5 * 60 * 1000);
  }

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await db.signIn($('#email').value, $('#password').value); location.reload(); }
    catch (e) { $('#loginMsg').textContent = e.message; }
  });
  $('#signOut').addEventListener('click', async () => { await db.signOut(); location.reload(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderActive());

  start();
})();
