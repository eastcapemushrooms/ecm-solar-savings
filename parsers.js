/* Parsers for the two NMBM ecWIN downloads.
 *  - Invoice ("Electricity Usage Advice") PDF text  -> invoice record
 *  - Profile export (.xls, Average Rate / Integration Period) rows -> half-hour intervals
 */
(function (root) {
  const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const num = (s) => (s == null || s === '' ? null : Number(String(s).replace(/,/g, '')));

  function parseInvoiceText(text) {
    const t = text.replace(/\s+/g, ' ');
    const period = t.match(/period (\d{2})-(\w{3})-(\d{2}) to/);
    if (!period) throw new Error('Could not find the billing period - is this an NMBM usage advice?');
    const month = `20${period[3]}-${String(MONTHS[period[2]]).padStart(2, '0')}`;

    // Six energy lines in order: winter peak/std/off, summer peak/std/off.
    const lines = [...t.matchAll(/(Peak|Standard|Off-peak) ([\d,.]+ )?kWh (\d+(?:\.\d+)?) c\/kWh/g)];
    if (lines.length !== 6) throw new Error(`Expected 6 energy lines, found ${lines.length}`);
    const r = lines.map((m) => num(m[3]));
    const k = lines.map((m) => num(m[2]) || 0);
    const rates = {
      winter: { peak: r[0], std: r[1], off: r[2] },
      summer: { peak: r[3], std: r[4], off: r[5] },
    };

    const demand = [...t.matchAll(/([\d,.]+) kVA R ([\d,.]+)\/kVA/g)]
      .map((m) => ({ kva: num(m[1]), rate: num(m[2]) }));
    const billedDemand = demand.find((d) => d.rate > 0) || demand[0];
    rates.demand = billedDemand ? billedDemand.rate : null;

    const basic = t.match(/Monthly Basic Charge \S+ R ([\d,.]+)/);
    rates.basic = basic ? num(basic[1]) : 0;

    const total = t.match(/(?:^|[^-A-Z])TOTAL R ([\d,.]+)/);
    if (!total) throw new Error('Could not find the TOTAL (excl. VAT)');
    const advice = t.match(/Usage Advice: (\d+)/);

    return {
      month,
      total_excl_vat: num(total[1]),
      kwh_peak: k[0] + k[3], kwh_std: k[1] + k[4], kwh_off: k[2] + k[5],
      max_kva: billedDemand ? billedDemand.kva : null,
      rates,
      source: advice ? advice[1] : 'pdf',
    };
  }

  /** Excel serial date (SAST wall-clock) -> UTC ms. */
  function excelSastToUtcMs(serial) {
    return Math.round((serial - 25569) * 86400000) - 2 * 3600000;
  }

  /**
   * rows: array of arrays from SheetJS (header row first).
   * Accepts the Average Rate export: Date | P (kW) | Q (kVAr).
   */
  function parseProfileRows(rows) {
    const header = rows[0].map((h) => String(h));
    const iP = header.findIndex((h) => /- P \(kW\)/.test(h));
    const iQ = header.findIndex((h) => /- Q \(kVAr\)/.test(h));
    if (iP < 0 || iQ < 0) {
      if (header.some((h) => /\(kVa\)/.test(h))) {
        throw new Error('This is the kVA export. Please export Profile Type "Average Rate" instead (P in kW and Q in kVAr).');
      }
      throw new Error('Could not find the P (kW) and Q (kVAr) columns.');
    }
    const out = [];
    for (const row of rows.slice(1)) {
      if (row[0] === '' || row[0] == null) continue;
      const serial = typeof row[0] === 'number' ? row[0] : null;
      if (serial == null) throw new Error(`Unexpected date value: ${row[0]}`);
      const p = num(row[iP]), q = num(row[iQ]);
      if (p == null || q == null) continue;
      out.push({ ts_end: new Date(excelSastToUtcMs(serial)).toISOString(), kw: p, kvar: q });
    }
    if (!out.length) throw new Error('No data rows found.');
    return out;
  }

  const api = { parseInvoiceText, parseProfileRows, excelSastToUtcMs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Parsers = api;
})(typeof window !== 'undefined' ? window : globalThis);
