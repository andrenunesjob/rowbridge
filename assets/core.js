/*! Rowbridge core: column detection, parsing and OFX/QFX/QBO generation.
 * Pure functions, no DOM, no network. Runs in the browser and in Node (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RBCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROLES = ['date', 'payee', 'memo', 'amount', 'debit', 'credit', 'dctype', 'checknum', 'balance'];

  // Header keywords per role. Order inside each list = preference.
  var HEADER_HINTS = {
    date: ['transaction date', 'trans date', 'posting date', 'posted date', 'post date', 'booking date', 'date posted',
      'date', 'datum', 'buchungstag', 'fecha', 'data', 'value date', 'valuta', 'posted', 'booked'],
    debit: ['debit amount', 'debits', 'debit', 'withdrawals', 'withdrawal', 'money out', 'paid out', 'outflow', 'out',
      'withdrawal amount', 'payments out', 'spent', 'charges', 'charge'],
    credit: ['credit amount', 'credits', 'credit', 'deposits', 'deposit', 'money in', 'paid in', 'inflow', 'in',
      'deposit amount', 'received'],
    amount: ['amount', 'transaction amount', 'amount usd', 'amount gbp', 'amount eur', 'amount cad', 'amount aud',
      'net amount', 'value', 'sum', 'betrag', 'importe', 'montant', 'bedrag', 'importo'],
    balance: ['balance', 'running balance', 'running bal', 'ledger balance', 'available balance', 'saldo', 'solde', 'kontostand'],
    checknum: ['check number', 'check no', 'check', 'cheque number', 'cheque no', 'cheque', 'chq no', 'chq', 'check num', 'checknum', 'serial number'],
    dctype: ['cr dr', 'dr cr', 'debit credit', 'credit debit', 'd c', 'c d', 'direction', 'in out', 'debit or credit', 'credit or debit', 'sign'],
    payee: ['payee', 'payee name', 'merchant', 'merchant name', 'name', 'description', 'transaction description',
      'details', 'transaction details', 'narrative', 'particulars', 'beneficiary', 'counterparty', 'counter party',
      'transaction', 'description 1', 'descripcion', 'beschreibung', 'omschrijving', 'libelle', 'buchungstext'],
    memo: ['memo', 'notes', 'note', 'reference', 'ref', 'description', 'details', 'additional info', 'extended description',
      'description 2', 'remarks', 'purpose', 'verwendungszweck', 'category', 'type', 'transaction type']
  };
  var DETECT_ORDER = ['date', 'dctype', 'debit', 'credit', 'amount', 'balance', 'checknum', 'payee', 'memo'];

  function normHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/\(.*?\)/g, ' $& ').replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim();
  }

  function headerScore(role, h) {
    if (!h) return 0;
    if ((role === 'debit' || role === 'credit') && /card|account|acct|number|limit|rating/.test(h)) return 0;
    if (role === 'amount' && /balance/.test(h)) return 0;
    if (role === 'date' && /balance|amount|time stamp|update/.test(h)) return 0;
    var hints = HEADER_HINTS[role];
    for (var i = 0; i < hints.length; i++) {
      if (h === hints[i]) return 100 - i;
    }
    if (role === 'in' || role === 'out') return 0;
    var words = ' ' + h + ' ';
    for (var j = 0; j < hints.length; j++) {
      if (hints[j].length < 3) continue; // avoid "in"/"out" partial matches
      if (words.indexOf(' ' + hints[j] + ' ') !== -1) return 50 - j;
    }
    return 0;
  }

  /* ---------------- numbers ---------------- */

  function cleanNumStr(s) {
    return String(s).replace(/[\s\u00a0\u202f']/g, '');
  }

  // Returns finite number or NaN. dec is '.' or ','.
  function parseNumber(v, dec) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).trim();
    if (!s) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = !neg; s = s.slice(1, -1).trim(); }
    var m = s.match(/\s*(cr|dr|db|credit|debit)\.?$/i);
    if (m) {
      if (/^d/i.test(m[1])) neg = !neg;
      s = s.slice(0, m.index).trim();
    }
    s = s.replace(/\u2212/g, '-');
    s = cleanNumStr(s);
    // strip currency symbols and 3-letter currency codes (e.g. "USD 12.00", "12,00EUR", "-$5", "A$5")
    s = s.replace(/^([-+(]?)[A-Z]{3}(?=[-+(]?[\d.,$\u00a3\u20ac])/, '$1').replace(/(\d)[A-Z]{3}(\)?)$/, '$1$2');
    s = s.replace(/(^|[-+(])(A|C|NZ|US|HK|S|R)\$/, '$1$');
    s = s.replace(/[$\u00a3\u20ac\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u0e3f\u20b1\u20ab]/g, '');
    if (/^[-+].*[-+]$/.test(s)) return NaN;
    if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    else if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
    else if (/^\+/.test(s)) { s = s.slice(1); }
    if (/^\(.*\)$/.test(s)) { neg = !neg; s = s.slice(1, -1); }
    if (dec === ',') s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    var n = parseFloat(s);
    return neg ? -n : n;
  }

  function detectDecimal(values) {
    var dot = 0, comma = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (typeof v === 'number' || v == null) continue;
      var s = cleanNumStr(v).replace(/[^0-9.,]/g, '');
      if (!s) continue;
      var hasDot = s.indexOf('.') !== -1, hasComma = s.indexOf(',') !== -1;
      if (hasDot && hasComma) {
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) comma += 3; else dot += 3;
      } else if (hasComma) {
        if (/,\d{1,2}$/.test(s)) comma += 2;
        else if (/,\d{3}$/.test(s) && /^\d{1,3}(,\d{3})+$/.test(s)) dot += 1;
        else if (/,\d+$/.test(s)) comma += 1;
      } else if (hasDot) {
        if (/\.\d{1,2}$/.test(s)) dot += 2;
        else if (/^\d{1,3}(\.\d{3})+$/.test(s)) comma += 1;
        else dot += 1;
      }
    }
    return comma > dot ? ',' : '.';
  }

  /* ---------------- dates ---------------- */

  var MONTHS = {
    jan: 1, january: 1, janv: 1, januar: 1, ene: 1, enero: 1, gen: 1,
    feb: 2, february: 2, fev: 2, fevr: 2, februar: 2, febrero: 2,
    mar: 3, march: 3, mars: 3, marz: 3, mrz: 3, marzo: 3, maerz: 3,
    apr: 4, april: 4, avr: 4, avril: 4, abr: 4, abril: 4,
    may: 5, mai: 5, mayo: 5, mag: 5, maggio: 5,
    jun: 6, june: 6, juin: 6, juni: 6, junio: 6, giu: 6,
    jul: 7, july: 7, juil: 7, juli: 7, julio: 7, lug: 7,
    aug: 8, august: 8, aout: 8, ago: 8, agosto: 8,
    sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, set: 9,
    oct: 10, october: 10, octobre: 10, okt: 10, oktober: 10, octubre: 10, ott: 10,
    nov: 11, november: 11, novembre: 11, noviembre: 11,
    dec: 12, december: 12, decembre: 12, dez: 12, dezember: 12, dic: 12, diciembre: 12
  };
  var WEEKDAYS = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/;

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function valid(y, m, d) { return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); }
  function fullYear(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }

  function fromSerial(n, date1904) {
    if (!(n > 0 && n < 2958466)) return null;
    var days = Math.floor(n) + (date1904 ? 1462 : 0);
    var t = Date.UTC(1899, 11, 30) + days * 86400000;
    var dt = new Date(t);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function stripAccents(s) { return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s; }

  function dateTokens(v) {
    var s = stripAccents(String(v).trim());
    s = s.replace(/T\d{2}:\d{2}.*$/, '');
    s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?\b/ig, ' ');
    s = s.replace(/\b(utc|gmt|[ap]m)\b/ig, ' ');
    s = s.replace(/(\d)(st|nd|rd|th)\b/ig, '$1');
    var toks = s.split(/[^0-9A-Za-z]+/).filter(Boolean);
    return toks.filter(function (t) { return !WEEKDAYS.test(t.toLowerCase()); });
  }

  // order: 'MDY' | 'DMY' | 'YMD'. Returns {y,m,d} or null.
  function parseDate(v, order, date1904) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
    if (typeof v === 'number') {
      if (v > 19000101 && v < 21001231 && Number.isInteger(v)) return parseDate(String(v), order);
      return fromSerial(v, date1904);
    }
    var toks = dateTokens(v);
    if (!toks.length) return null;
    var y, m, d;
    if (toks.length === 1) {
      var t = toks[0];
      if (/^(19|20)\d{6}$/.test(t)) { y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8); }
      else if (/^\d{5}(\.\d+)?$/.test(t)) { return fromSerial(+t, date1904); }
      else return null;
      return valid(y, m, d) ? { y: y, m: m, d: d } : null;
    }
    var alphaIdx = -1;
    for (var i = 0; i < toks.length; i++) {
      if (/[a-z]/i.test(toks[i])) {
        var key = toks[i].toLowerCase().replace(/\.$/, '');
        if (MONTHS[key] == null && MONTHS[key.slice(0, 3)] == null) return null;
        if (alphaIdx !== -1) return null;
        alphaIdx = i;
      }
    }
    if (alphaIdx !== -1) {
      var mk = toks[alphaIdx].toLowerCase();
      m = MONTHS[mk] != null ? MONTHS[mk] : MONTHS[mk.slice(0, 3)];
      var nums = toks.filter(function (_, k) { return k !== alphaIdx; }).map(Number);
      if (nums.length < 2) return null;
      var yi = nums.findIndex(function (n) { return n > 31; });
      if (yi === -1) yi = (alphaIdx === 0 ? nums.length - 1 : nums.length - 1);
      y = fullYear(nums[yi]);
      d = nums[yi === 0 ? 1 : 0];
      return valid(y, m, d) ? { y: y, m: m, d: d } : null;
    }
    if (toks.length < 3) return null;
    var a = +toks[0], b = +toks[1], c = +toks[2];
    if (toks[0].length === 4) { y = a; m = b; d = c; }
    else if (order === 'YMD' && toks[0].length <= 2 && toks[2].length <= 2) { y = fullYear(a); m = b; d = c; }
    else if (order === 'DMY') { d = a; m = b; y = fullYear(c); }
    else { m = a; d = b; y = fullYear(c); }
    return valid(y, m, d) ? { y: y, m: m, d: d } : null;
  }

  function looksLikeDate(v) {
    if (v == null || v === '') return false;
    if (typeof v === 'number') return false;
    var s = String(v).trim();
    if (s.length < 6 || s.length > 40) return false;
    return !!(parseDate(s, 'MDY') || parseDate(s, 'DMY'));
  }

  function ymdNum(p) { return p.y * 10000 + p.m * 100 + p.d; }

  // Returns {order, ambiguous, reason}
  function detectDateOrder(values, decimal) {
    var dmyForced = false, mdyForced = false, sawYMD = 0, sawNumeric = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v == null || v === '' || typeof v === 'number') continue;
      var toks = dateTokens(v);
      if (toks.length < 3 || toks.some(function (t) { return /[a-z]/i.test(t); })) continue;
      if (toks[0].length === 4) { sawYMD++; continue; }
      sawNumeric++;
      var a = +toks[0], b = +toks[1];
      if (a > 12 && b <= 12) dmyForced = true;
      if (b > 12 && a <= 12) mdyForced = true;
    }
    if (sawYMD && !sawNumeric) return { order: 'YMD', ambiguous: false, reason: 'year first' };
    if (!sawNumeric) return { order: 'MDY', ambiguous: false, reason: 'month names' };
    if (dmyForced && !mdyForced) return { order: 'DMY', ambiguous: false, reason: 'day > 12 in first position' };
    if (mdyForced && !dmyForced) return { order: 'MDY', ambiguous: false, reason: 'day > 12 in second position' };
    // Ambiguous: pick the interpretation whose dates are most monotonic (bank exports are sorted).
    function changes(order) {
      var prev = null, dir = 0, flips = 0, bad = 0;
      for (var j = 0; j < values.length; j++) {
        var p = parseDate(values[j], order);
        if (!p) { bad++; continue; }
        var n = ymdNum(p);
        if (prev != null && n !== prev) {
          var nd = n > prev ? 1 : -1;
          if (dir && nd !== dir) flips++;
          dir = nd;
        }
        prev = n;
      }
      return flips + bad * 2;
    }
    var cm = changes('MDY'), cd = changes('DMY');
    if (cd < cm) return { order: 'DMY', ambiguous: true, reason: 'chronological order' };
    if (cm < cd) return { order: 'MDY', ambiguous: true, reason: 'chronological order' };
    return { order: decimal === ',' ? 'DMY' : 'MDY', ambiguous: true, reason: 'guess' };
  }

  /* ---------------- table analysis ---------------- */

  function isEmptyRow(r) {
    if (!r) return true;
    for (var i = 0; i < r.length; i++) if (r[i] !== '' && r[i] != null && String(r[i]).trim() !== '') return false;
    return true;
  }

  function rowHeaderScore(r) {
    var score = 0, roles = {};
    for (var i = 0; i < r.length; i++) {
      var h = normHeader(r[i]);
      if (!h || /^[-+]?[\d.,\s]+$/.test(h)) continue;
      for (var k = 0; k < ROLES.length; k++) {
        if (headerScore(ROLES[k], h) > 0) { roles[ROLES[k]] = true; score++; break; }
      }
    }
    var strong = (roles.date ? 1 : 0) + ((roles.amount || roles.debit || roles.credit) ? 1 : 0);
    return { score: score, strong: strong };
  }

  function findHeaderRow(rows) {
    var limit = Math.min(rows.length, 25);
    for (var i = 0; i < limit; i++) {
      if (isEmptyRow(rows[i])) continue;
      var s = rowHeaderScore(rows[i]);
      if (s.strong === 2 || (s.score >= 3 && s.strong >= 1)) return i;
    }
    // no recognisable header: if first non-empty row already looks like data, there is no header
    for (var j = 0; j < limit; j++) {
      if (isEmptyRow(rows[j])) continue;
      if (rows[j].some(looksLikeDate)) return -1;
      return j;
    }
    return -1;
  }

  function columnValues(rows, idx, max) {
    var out = [];
    for (var i = 0; i < rows.length && out.length < (max || 400); i++) {
      var v = rows[i][idx];
      if (v !== '' && v != null) out.push(v);
    }
    return out;
  }

  function detectByContent(dataRows, ncols, mapping, taken, dec) {
    var stats = [];
    for (var c = 0; c < ncols; c++) {
      if (taken[c]) { stats.push(null); continue; }
      var vals = columnValues(dataRows, c, 200);
      var filled = vals.length;
      var dates = 0, nums = 0, len = 0, uniq = {};
      vals.forEach(function (v) {
        if (typeof v === 'number') nums++;
        else if (looksLikeDate(v)) dates++;
        else if (!isNaN(parseNumber(v, dec))) nums++;
        len += String(v).length; uniq[String(v)] = 1;
      });
      stats.push({ c: c, filled: filled, dates: dates, nums: nums, avgLen: filled ? len / filled : 0, uniq: Object.keys(uniq).length });
    }
    var total = dataRows.length || 1;
    if (mapping.date == null) {
      var best = null;
      stats.forEach(function (s) { if (s && s.filled && s.dates / s.filled > 0.8 && (!best || s.dates > best.dates)) best = s; });
      if (best) { mapping.date = best.c; taken[best.c] = true; stats[best.c] = null; }
    }
    if (mapping.amount == null && mapping.debit == null && mapping.credit == null) {
      var numCols = stats.filter(function (s) { return s && s.filled && s.nums / s.filled > 0.9; });
      // check complementary pairs (debit/credit split)
      var paired = false;
      for (var i = 0; i < numCols.length - 1 && !paired; i++) {
        var a = numCols[i].c, b = numCols[i + 1].c, comp = 0, rowsN = 0;
        dataRows.forEach(function (r) {
          var x = r[a] !== '' && r[a] != null, y = r[b] !== '' && r[b] != null;
          if (x || y) { rowsN++; if (x !== y) comp++; }
        });
        if (rowsN && comp / rowsN > 0.9) {
          mapping.debit = a; mapping.credit = b; taken[a] = taken[b] = true; paired = true;
          var rest = numCols.filter(function (s) { return s.c > b; });
          if (rest.length && mapping.balance == null) { mapping.balance = rest[rest.length - 1].c; taken[mapping.balance] = true; }
        }
      }
      if (!paired && numCols.length) {
        var full = numCols.filter(function (s) { return s.filled / total > 0.9; });
        var pick = (full.length ? full : numCols)[0];
        mapping.amount = pick.c; taken[pick.c] = true;
        var others = numCols.filter(function (s) { return s.c !== pick.c && s.c > pick.c; });
        if (others.length && mapping.balance == null) { mapping.balance = others[others.length - 1].c; taken[mapping.balance] = true; }
      }
    }
    if (mapping.payee == null) {
      var txt = stats.filter(function (s) { return s && !taken[s.c] && s.filled && s.nums / s.filled < 0.5 && s.dates / s.filled < 0.5; });
      txt.sort(function (x, y) { return (y.uniq * y.avgLen) - (x.uniq * x.avgLen); });
      if (txt.length) { mapping.payee = txt[0].c; taken[txt[0].c] = true; }
    }
  }

  function analyze(rows, opts) {
    opts = opts || {};
    rows = (rows || []).map(function (r) { return (r || []).map(function (v) { return typeof v === 'string' ? v.trim() : v; }); });
    var headerRow = opts.headerRow != null ? opts.headerRow : findHeaderRow(rows);
    var ncols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var headers = [];
    for (var c = 0; c < ncols; c++) {
      var h = headerRow >= 0 ? rows[headerRow][c] : '';
      headers.push(h != null && String(h).trim() !== '' ? String(h).trim() : 'Column ' + (c + 1));
    }
    var dataRows = rows.slice(headerRow + 1).filter(function (r) { return !isEmptyRow(r); });
    var mapping = {};
    ROLES.forEach(function (r) { mapping[r] = null; });
    var taken = {};
    if (headerRow >= 0) {
      DETECT_ORDER.forEach(function (role) {
        var best = -1, bestScore = 0;
        for (var c2 = 0; c2 < ncols; c2++) {
          if (taken[c2]) continue;
          var sc = headerScore(role, normHeader(headers[c2]));
          if (sc > bestScore) { bestScore = sc; best = c2; }
        }
        if (best >= 0) {
          if (role === 'dctype') {
            var vals = columnValues(dataRows, best, 200);
            var ok = vals.length && vals.every(function (v) { return /^(d|c|dr|cr|db|debit|credit|in|out|\+|-)$/i.test(String(v).trim()); });
            if (!ok) return;
          }
          mapping[role] = best; taken[best] = true;
        }
      });
      // a lone "credit" or "debit" column without its partner is usually a signed amount column
      if (mapping.amount == null && (mapping.debit == null) !== (mapping.credit == null)) {
        var lone = mapping.debit != null ? 'debit' : 'credit';
        mapping.amount = mapping[lone]; mapping[lone] = null;
      }
      if (mapping.amount != null && mapping.debit != null && mapping.credit == null) { taken[mapping.debit] = false; mapping.debit = null; }
      if (mapping.amount != null && mapping.credit != null && mapping.debit == null) { taken[mapping.credit] = false; mapping.credit = null; }
      if (mapping.amount != null && mapping.debit != null && mapping.credit != null) {
        // both present: prefer split columns only if the amount column is mostly empty
        var amtFilled = columnValues(dataRows, mapping.amount).length;
        if (amtFilled >= dataRows.length * 0.9) { taken[mapping.debit] = taken[mapping.credit] = false; mapping.debit = mapping.credit = null; }
        else { taken[mapping.amount] = false; mapping.amount = null; }
      }
    }
    // values-based detection for decimal before content analysis
    var amtCols = ['amount', 'debit', 'credit', 'balance'].map(function (r) { return mapping[r]; }).filter(function (x) { return x != null; });
    var numericSample = [];
    if (amtCols.length) amtCols.forEach(function (c3) { numericSample = numericSample.concat(columnValues(dataRows, c3, 300)); });
    else dataRows.slice(0, 200).forEach(function (r) { r.forEach(function (v) { if (typeof v === 'string' && /^[-+(]?[^A-Za-z]*\d[\d.,\s']*\)?$/.test(v) && !looksLikeDate(v)) numericSample.push(v); }); });
    var decimal = detectDecimal(numericSample);
    detectByContent(dataRows, ncols, mapping, taken, decimal);
    if (mapping.amount == null && mapping.debit == null && mapping.credit == null) { /* leave for user */ }
    // recompute decimal with final amount columns
    var finalCols = ['amount', 'debit', 'credit', 'balance'].map(function (r) { return mapping[r]; }).filter(function (x) { return x != null; });
    if (finalCols.length) {
      var smp = [];
      finalCols.forEach(function (c4) { smp = smp.concat(columnValues(dataRows, c4, 300)); });
      decimal = detectDecimal(smp);
    }
    var dateInfo = mapping.date != null ? detectDateOrder(columnValues(dataRows, mapping.date, 1000), decimal)
      : { order: 'MDY', ambiguous: true, reason: 'no date column' };
    return {
      headerRow: headerRow, headers: headers, ncols: ncols, dataRows: dataRows,
      mapping: mapping, decimal: decimal, dateOrder: dateInfo.order, dateAmbiguous: dateInfo.ambiguous, dateReason: dateInfo.reason
    };
  }

  /* ---------------- transactions ---------------- */

  function cellStr(v) {
    if (v == null) return '';
    return String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function iso(p) { return p.y + '-' + pad(p.m) + '-' + pad(p.d); }

  // opts: {dateOrder, decimal, flipSigns, date1904}
  function buildTransactions(dataRows, mapping, opts) {
    opts = opts || {};
    var txns = [], errors = [], skipped = 0;
    var M = mapping;
    for (var i = 0; i < dataRows.length; i++) {
      var r = dataRows[i];
      if (isEmptyRow(r)) continue;
      var rawDate = M.date != null ? r[M.date] : null;
      var p = parseDate(rawDate, opts.dateOrder, opts.date1904);
      var cents = null, amtErr = null;
      if (M.amount != null) {
        var a = parseNumber(r[M.amount], opts.decimal);
        if (isNaN(a)) amtErr = 'amount "' + cellStr(r[M.amount]) + '" is not a number';
        else {
          if (M.dctype != null) {
            var t = String(r[M.dctype] || '').trim().toLowerCase();
            if (/^(d|dr|db|debit|out|-)$/.test(t)) a = -Math.abs(a);
            else if (/^(c|cr|credit|in|\+)$/.test(t)) a = Math.abs(a);
          }
          cents = Math.round(a * 100);
        }
      } else if (M.debit != null || M.credit != null) {
        var dv = M.debit != null ? r[M.debit] : '', cv = M.credit != null ? r[M.credit] : '';
        var dn = parseNumber(dv, opts.decimal), cn = parseNumber(cv, opts.decimal);
        if (isNaN(dn) && isNaN(cn)) amtErr = (cellStr(dv) || cellStr(cv)) ? 'debit/credit is not a number' : 'no amount';
        else cents = Math.round(((isNaN(cn) ? 0 : Math.abs(cn)) - (isNaN(dn) ? 0 : Math.abs(dn))) * 100);
      } else amtErr = 'no amount column mapped';
      if (!p || amtErr) {
        // Footer/summary lines (e.g. "Total", "Closing balance") without a date are skipped quietly.
        if (!p && (rawDate == null || cellStr(rawDate) === '' || /total|balance|opening|closing|summary|statement/i.test(r.join(' ')))) { skipped++; continue; }
        errors.push({ row: i + 1, raw: r, reason: !p ? 'date "' + cellStr(rawDate) + '" not recognised' : amtErr });
        continue;
      }
      if (opts.flipSigns) cents = -cents;
      var payee = M.payee != null ? cellStr(r[M.payee]) : '';
      var memo = M.memo != null ? cellStr(r[M.memo]) : '';
      if (!payee) { payee = memo || '(no description)'; if (memo) memo = ''; }
      if (memo === payee) memo = '';
      var bal = null;
      if (M.balance != null) { var b = parseNumber(r[M.balance], opts.decimal); if (!isNaN(b)) bal = Math.round(b * 100); }
      var chk = M.checknum != null ? cellStr(r[M.checknum]).replace(/^#/, '').slice(0, 12) : '';
      if (chk && !/[0-9A-Za-z]/.test(chk)) chk = '';
      txns.push({ date: p, iso: iso(p), cents: cents, payee: payee, memo: memo, checknum: chk, balance: bal, index: i });
    }
    return { txns: txns, errors: errors, skipped: skipped };
  }

  /* ---------------- FITID ---------------- */

  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function assignFitids(txns, acctId) {
    var seen = {};
    txns.forEach(function (t) {
      var key = [acctId || '', t.iso, t.cents, t.payee, t.memo, t.checknum].join('|');
      var h = pad(fnv1a(key, 2166136261).toString(16), 8) + pad(fnv1a(key, 0x811c9dc5 ^ 0x5bd1e995).toString(16), 8);
      var base = t.iso.replace(/-/g, '') + h.toUpperCase();
      var n = seen[base] || 0;
      seen[base] = n + 1;
      t.fitid = n ? base + '-' + n : base;
    });
    return txns;
  }

  /* ---------------- OFX generation ---------------- */

  function asciiFold(s) {
    s = String(s);
    var map = { '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE', '\u00f8': 'o', '\u00d8': 'O', '\u0153': 'oe', '\u0152': 'OE',
      '\u0142': 'l', '\u0141': 'L', '\u20ac': 'EUR', '\u00a3': 'GBP', '\u00a5': 'JPY', '\u2018': "'", '\u2019': "'",
      '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00a0': ' ', '\u00d0': 'D', '\u00f0': 'd', '\u00fe': 'th', '\u00de': 'Th' };
    s = s.replace(/[\u00df\u00e6\u00c6\u00f8\u00d8\u0153\u0152\u0142\u0141\u20ac\u00a3\u00a5\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0\u00d0\u00f0\u00fe\u00de]/g, function (c) { return map[c]; });
    s = stripAccents(s);
    return s.replace(/[^\x20-\x7e]/g, '');
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function amt(cents) {
    var neg = cents < 0, a = Math.abs(cents);
    return (neg ? '-' : '') + Math.floor(a / 100) + '.' + pad(a % 100);
  }
  function ofxDate(p, hms) { return p.y + pad(p.m) + pad(p.d) + (hms || '120000'); }
  function nowStamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  }
  function cmpTxn(a, b) { return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : a.index - b.index; }

  function ledgerFromBalances(txns) {
    // txns in original file order; find the balance of the latest transaction
    var withBal = txns.filter(function (t) { return t.balance != null; });
    if (!withBal.length) return null;
    var first = withBal[0], last = withBal[withBal.length - 1];
    var newestFirst = first.iso > last.iso;
    var maxIso = withBal.reduce(function (m, t) { return t.iso > m ? t.iso : m; }, '');
    var onMax = withBal.filter(function (t) { return t.iso === maxIso; });
    onMax.sort(function (a, b) { return a.index - b.index; });
    return (newestFirst ? onMax[0] : onMax[onMax.length - 1]).balance;
  }

  /**
   * settings: {format:'qbo'|'qfx'|'ofx', syntax:'sgml'|'xml', acctType:'CHECKING'|'SAVINGS'|'MONEYMRKT'|'CREDITCARD',
   *   bankId, acctId, currency, intuBid, org, fid, ledgerCents (optional), now (Date), limit (optional)}
   * Returns {text, count, total, truncated, dtStart, dtEnd, ledgerCents, ledgerSource, filenameExt}
   */
  function generate(txnsIn, settings) {
    var s = settings || {};
    var format = s.format || 'qbo';
    var xml = format === 'ofx' && s.syntax === 'xml';
    // XML keeps every character but writes non-ASCII as numeric references, so the file itself stays pure ASCII
    // (several OFX readers, including Python's ofxparse, assume ASCII).
    var fold = xml ? function (x) { return String(x); } : asciiFold;
    var escOut = xml ? function (x) {
      return esc(x).replace(/[^\x20-\x7e]/g, function (ch) { return '&#' + ch.codePointAt(0) + ';'; }).replace(/[\ud800-\udfff]/g, '');
    } : esc;
    var all = txnsIn.slice();
    var sorted = all.slice().sort(cmpTxn);
    var total = sorted.length;
    var limited = s.limit && total > s.limit ? sorted.slice(0, s.limit) : sorted;
    if (!limited.length) throw new Error('No transactions to convert.');
    var acctId = fold(String(s.acctId || '').replace(/\s+/g, '')).slice(0, 22) || '0000000001';
    assignFitids(sorted, acctId);
    var cc = s.acctType === 'CREDITCARD';
    var dtStart = limited[0].date, dtEnd = limited[limited.length - 1].date;
    var ledger, ledgerSource;
    var included = all.filter(function (t) { return limited.indexOf(t) !== -1; });
    var fromBal = ledgerFromBalances(included);
    if (s.ledgerCents != null && !isNaN(s.ledgerCents) && !(s.limit && total > s.limit)) { ledger = s.ledgerCents; ledgerSource = 'entered'; }
    else if (fromBal != null) { ledger = fromBal; ledgerSource = 'balance column'; }
    else { ledger = limited.reduce(function (m, t) { return m + t.cents; }, 0); ledgerSource = 'net of transactions'; }
    var now = s.now || new Date();
    var stamp = nowStamp(now);
    var cur = (s.currency || 'USD').toUpperCase();
    var useIntu = format === 'qbo' || format === 'qfx';
    var bid = String(s.intuBid || '3000').replace(/[^0-9]/g, '') || '3000';
    var org = fold(s.org || (bid === '3000' ? 'Wells Fargo' : 'Bank')).slice(0, 32);
    var fid = String(s.fid || bid).replace(/[^0-9A-Za-z]/g, '') || bid;

    var lines = [];
    var NL = '\r\n';
    function open(tag) { lines.push('<' + tag + '>'); }
    function close(tag) { lines.push('</' + tag + '>'); }
    function el(tag, val) {
      if (val == null || val === '') return;
      var v = escOut(fold(val));
      lines.push(xml ? '<' + tag + '>' + v + '</' + tag + '>' : '<' + tag + '>' + v);
    }

    if (xml) {
      lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
      lines.push('<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>');
    } else {
      lines.push('OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252',
        'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '');
    }
    open('OFX');
    open('SIGNONMSGSRSV1'); open('SONRS');
    open('STATUS'); el('CODE', '0'); el('SEVERITY', 'INFO'); close('STATUS');
    el('DTSERVER', stamp); el('LANGUAGE', 'ENG');
    if (useIntu || s.org) { open('FI'); el('ORG', org); el('FID', fid); close('FI'); }
    if (useIntu) el('INTU.BID', bid);
    close('SONRS'); close('SIGNONMSGSRSV1');

    var msgs = cc ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1';
    var trnrs = cc ? 'CCSTMTTRNRS' : 'STMTTRNRS';
    var stmtrs = cc ? 'CCSTMTRS' : 'STMTRS';
    open(msgs); open(trnrs);
    el('TRNUID', '1');
    open('STATUS'); el('CODE', '0'); el('SEVERITY', 'INFO'); close('STATUS');
    open(stmtrs);
    el('CURDEF', cur);
    if (cc) { open('CCACCTFROM'); el('ACCTID', acctId); close('CCACCTFROM'); }
    else {
      open('BANKACCTFROM');
      el('BANKID', (String(s.bankId || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 9)) || '123456789');
      el('ACCTID', acctId);
      el('ACCTTYPE', s.acctType || 'CHECKING');
      close('BANKACCTFROM');
    }
    open('BANKTRANLIST');
    el('DTSTART', ofxDate(dtStart, '000000'));
    el('DTEND', ofxDate(dtEnd, '235959'));
    limited.forEach(function (t) {
      open('STMTTRN');
      var type = t.cents < 0 ? (t.checknum && !cc ? 'CHECK' : 'DEBIT') : 'CREDIT';
      el('TRNTYPE', type);
      el('DTPOSTED', ofxDate(t.date));
      el('TRNAMT', amt(t.cents));
      el('FITID', t.fitid);
      if (t.checknum) el('CHECKNUM', t.checknum);
      var name = fold(t.payee).trim();
      var memo = t.memo;
      if (name.length > 32) { if (!memo) memo = t.payee; else memo = t.payee + ' - ' + memo; name = name.slice(0, 32).trim(); }
      el('NAME', name || 'Transaction');
      if (memo) el('MEMO', fold(memo).slice(0, 255));
      close('STMTTRN');
    });
    close('BANKTRANLIST');
    open('LEDGERBAL'); el('BALAMT', amt(ledger)); el('DTASOF', ofxDate(dtEnd, '235959')); close('LEDGERBAL');
    close(stmtrs); close(trnrs); close(msgs);
    close('OFX');
    return {
      text: lines.join(NL) + NL,
      count: limited.length, total: total, truncated: limited.length < total,
      dtStart: iso(dtStart), dtEnd: iso(dtEnd), ledgerCents: ledger, ledgerSource: ledgerSource,
      ext: format
    };
  }

  function decodeText(buf) {
    // buf: ArrayBuffer/Uint8Array. Try UTF-8 strictly, fall back to Windows-1252.
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { text = new TextDecoder('windows-1252').decode(bytes); }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  /* ---------------- file -> rows (libraries passed in so this stays dependency-free) ---------------- */

  function csvToRows(text, Papa) {
    // Pick the delimiter that yields the most rows sharing the same (multi-column) field count.
    // More robust than auto-guessing when a file has a preamble or "1.234,56" style numbers.
    var best = null;
    [',', ';', '\t', '|'].forEach(function (d) {
      var rows = Papa.parse(text, { skipEmptyLines: 'greedy', delimiter: d }).data || [];
      var counts = {};
      rows.forEach(function (r) { if (r.length > 1) counts[r.length] = (counts[r.length] || 0) + 1; });
      var score = 0;
      Object.keys(counts).forEach(function (k) { var sc = counts[k] * Math.min(+k, 8); if (sc > score) score = sc; });
      if (!best || score > best.score) best = { score: score, rows: rows };
    });
    return best ? best.rows : [];
  }

  function workbookToRows(XLSX, wb, sheetName) {
    var ws = wb.Sheets[sheetName || wb.SheetNames[0]];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
  }
  function workbookIs1904(wb) { return !!(wb && wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904); }

  return {
    csvToRows: csvToRows, workbookToRows: workbookToRows, workbookIs1904: workbookIs1904,
    ROLES: ROLES, analyze: analyze, buildTransactions: buildTransactions, generate: generate,
    parseNumber: parseNumber, parseDate: parseDate, detectDecimal: detectDecimal, detectDateOrder: detectDateOrder,
    findHeaderRow: findHeaderRow, assignFitids: assignFitids, asciiFold: asciiFold, decodeText: decodeText, formatAmount: amt, iso: iso
  };
});
