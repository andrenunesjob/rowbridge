/* Rowbridge converter UI. Everything happens in this tab: no file data is sent anywhere. */
(function () {
  'use strict';
  var C = window.RBCore;
  var FREE_LIMIT = 30;
  var $ = function (id) { return document.getElementById(id); };
  var ROLE_LABELS = {
    date: 'Date', payee: 'Description / payee', memo: 'Memo (optional)', amount: 'Amount (signed)',
    debit: 'Debit / money out', credit: 'Credit / money in', dctype: 'Debit/credit indicator', checknum: 'Check number', balance: 'Running balance'
  };
  var ROLE_ORDER = ['date', 'payee', 'memo', 'amount', 'debit', 'credit', 'dctype', 'checknum', 'balance'];
  var state = { rows: null, fileName: '', analysis: null, mapping: null, built: null, wb: null, date1904: false };
  var BASE = (window.RB_CONFIG && window.RB_CONFIG.base) || '/';
  var track = function (n, p) { if (window.rbTrack) window.rbTrack(n, p); };

  /* ---------- helpers ---------- */
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function status(msg, kind) {
    var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (kind ? ' ' + kind : '');
  }
  function money(cents, cur) {
    var v = cents / 100;
    try { return v.toLocaleString(undefined, { style: 'currency', currency: cur || 'USD' }); }
    catch (e) { return v.toFixed(2); }
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = el('script', { src: src }); s.onload = res; s.onerror = function () { rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function baseName(n) { return (n || 'statement').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'statement'; }
  function prefs() { try { return JSON.parse(localStorage.getItem('rb_out') || '{}'); } catch (e) { return {}; } }
  function savePrefs() {
    try {
      localStorage.setItem('rb_out', JSON.stringify({ format: fmt(), syntax: $('syntax').value, acctType: $('acctType').value, currency: $('currency').value, bid: $('intuBid').value }));
    } catch (e) { /* private mode */ }
  }
  function fmt() { var r = document.querySelector('input[name="format"]:checked'); return r ? r.value : 'qbo'; }

  /* ---------- file loading ---------- */
  function handleFile(file) {
    if (!file) return;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    state.fileName = file.name;
    if (file.size > 30 * 1024 * 1024) { status('That file is larger than 30 MB. Is it really a bank export?', 'error'); return; }
    status('Reading ' + file.name + ' on this device…');
    var reader = new FileReader();
    reader.onerror = function () { status('Could not read the file.', 'error'); };
    reader.onload = function () {
      var buf = reader.result;
      if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') {
        status('Loading the Excel reader (first time only)…');
        loadScript(BASE + 'vendor/xlsx.full.min.js').then(function () {
          var wb = window.XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
          state.wb = wb; state.date1904 = C.workbookIs1904(wb);
          var sel = $('sheet'); sel.innerHTML = '';
          wb.SheetNames.forEach(function (n) { sel.appendChild(el('option', { value: n }, n)); });
          sel.hidden = wb.SheetNames.length < 2;
          // pick the first sheet that has data
          var first = wb.SheetNames.find(function (n) { return C.workbookToRows(window.XLSX, wb, n).length > 1; }) || wb.SheetNames[0];
          sel.value = first;
          setRows(C.workbookToRows(window.XLSX, wb, first), 'excel');
        }).catch(function (e) { status('Could not read this Excel file: ' + e.message, 'error'); });
      } else {
        state.wb = null; state.date1904 = false; $('sheet').hidden = true;
        var text = C.decodeText(buf);
        if (/^\s*(OFXHEADER|<\?xml|<OFX)/i.test(text)) { status('This already looks like an OFX/QFX/QBO file, not a CSV.', 'error'); return; }
        if (/^%PDF/.test(text)) { status('PDF statements are not supported yet. Download CSV or Excel from your online banking instead.', 'error'); return; }
        setRows(C.csvToRows(text, window.Papa), 'csv');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function setRows(rows, kind, headerRow) {
    if (!rows || rows.length < 1) { status('No rows found in this file.', 'error'); return; }
    state.rows = rows;
    var a = C.analyze(rows, headerRow != null ? { headerRow: headerRow } : null);
    state.analysis = a;
    state.mapping = Object.assign({}, a.mapping);
    $('work').hidden = false;
    if (state.shownFile !== state.fileName) { $('ledger').value = ''; $('flip').checked = false; state.shownFile = state.fileName; } // per-file settings
    $('fileName').textContent = state.fileName;
    buildHeaderSelect(rows, a.headerRow);
    buildMappingUI();
    $('dateOrder').value = a.dateOrder;
    $('decimal').value = a.decimal;
    $('flip').checked = false;
    status('');
    if (kind) track('file_loaded', { label: kind });
    refresh();
    $('work').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function buildHeaderSelect(rows, current) {
    var sel = $('headerRow'); sel.innerHTML = '';
    sel.appendChild(el('option', { value: '-1' }, 'No header row'));
    for (var i = 0; i < Math.min(rows.length, 25); i++) {
      var preview = rows[i].filter(function (v) { return v !== '' && v != null; }).slice(0, 3).join(' | ').slice(0, 50);
      sel.appendChild(el('option', { value: String(i) }, 'Row ' + (i + 1) + (preview ? ': ' + preview : '')));
    }
    sel.value = String(current);
  }

  function buildMappingUI() {
    var box = $('mapFields'); box.innerHTML = '';
    var a = state.analysis;
    ROLE_ORDER.forEach(function (role) {
      var id = 'map-' + role;
      var wrap = el('div', { class: 'field' + (['dctype', 'checknum', 'balance'].indexOf(role) !== -1 ? ' minor' : '') });
      wrap.appendChild(el('label', { for: id }, ROLE_LABELS[role]));
      var s = el('select', { id: id, 'data-role': role });
      s.appendChild(el('option', { value: '' }, '(none)'));
      a.headers.forEach(function (h, i) {
        var sample = '';
        for (var r = 0; r < a.dataRows.length && !sample; r++) { var v = a.dataRows[r][i]; if (v !== '' && v != null) sample = String(v); }
        s.appendChild(el('option', { value: String(i) }, h + (sample && sample !== h ? '  (e.g. ' + sample.slice(0, 24) + ')' : '')));
      });
      s.value = state.mapping[role] != null ? String(state.mapping[role]) : '';
      s.addEventListener('change', function () {
        state.mapping[role] = s.value === '' ? null : +s.value;
        // amount and debit/credit are alternatives
        if (role === 'amount' && s.value !== '') { state.mapping.debit = state.mapping.credit = null; }
        if ((role === 'debit' || role === 'credit') && s.value !== '') { state.mapping.amount = null; }
        syncMappingUI();
        refresh();
      });
      wrap.appendChild(s);
      box.appendChild(wrap);
    });
  }
  function syncMappingUI() {
    ROLE_ORDER.forEach(function (role) {
      var s = $('map-' + role); if (s) s.value = state.mapping[role] != null ? String(state.mapping[role]) : '';
    });
  }

  /* ---------- preview ---------- */
  function refresh() {
    if (!state.analysis) return;
    var a = state.analysis, M = state.mapping;
    var opts = { dateOrder: $('dateOrder').value, decimal: $('decimal').value, flipSigns: $('flip').checked, date1904: state.date1904 };
    var problems = [];
    if (M.date == null) problems.push('Pick the column that holds the transaction date.');
    if (M.amount == null && M.debit == null && M.credit == null) problems.push('Pick an Amount column, or the Debit and Credit columns.');
    var built = problems.length ? { txns: [], errors: [], skipped: 0 } : C.buildTransactions(a.dataRows, M, opts);
    state.built = built;
    var cur = $('currency').value;
    var sum = $('summary'); sum.innerHTML = '';
    var warn = $('dateWarn');
    var dateVals = M.date != null ? a.dataRows.map(function (r) { return r[M.date]; }) : [];
    var textDates = dateVals.some(function (v) { return typeof v === 'string' && /^\d{1,2}\D\d{1,2}\D\d{2,4}/.test(v.trim()); });
    warn.hidden = !(a.dateAmbiguous && textDates && $('dateOrder').value === a.dateOrder);
    if (!warn.hidden) {
      warn.textContent = 'Heads-up: every date in this file could be read as day/month or month/day. We picked ' +
        ($('dateOrder').value === 'DMY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY') + ' because the rows are in date order that way. Check the dates below.';
    }
    if (problems.length) {
      problems.forEach(function (p) { sum.appendChild(el('p', { class: 'error' }, p)); });
      renderTable([]); $('download').disabled = true; $('limitNote').hidden = true; $('rowErrors').innerHTML = '';
      return;
    }
    var txns = built.txns.slice().sort(function (x, y) { return x.iso < y.iso ? -1 : x.iso > y.iso ? 1 : x.index - y.index; });
    var inC = 0, outC = 0;
    txns.forEach(function (t) { if (t.cents >= 0) inC += t.cents; else outC += t.cents; });
    if (txns.length) {
      var line = el('p');
      line.innerHTML = '<strong></strong> transactions from <strong></strong> to <strong></strong> · money in <span class="pos"></span> · money out <span class="neg"></span>';
      var f = line.querySelectorAll('strong,span');
      f[0].textContent = txns.length; f[1].textContent = txns[0].iso; f[2].textContent = txns[txns.length - 1].iso;
      f[3].textContent = money(inC, cur); f[4].textContent = money(outC, cur);
      sum.appendChild(line);
    } else sum.appendChild(el('p', { class: 'error' }, 'No transactions could be read with this mapping. Check the date and amount columns.'));
    renderTable(txns.slice(0, 12), txns.length);
    var errBox = $('rowErrors'); errBox.innerHTML = '';
    if (built.errors.length) {
      var d = el('details', { class: 'row-errors' });
      d.appendChild(el('summary', null, built.errors.length + ' row' + (built.errors.length > 1 ? 's' : '') + ' skipped because they could not be read'));
      var ul = el('ul');
      built.errors.slice(0, 20).forEach(function (er) { ul.appendChild(el('li', null, 'Data row ' + er.row + ': ' + er.reason)); });
      d.appendChild(ul); errBox.appendChild(d);
    }
    var ln = $('limitNote');
    if (txns.length > FREE_LIMIT) {
      ln.hidden = false;
      ln.innerHTML = '';
      ln.appendChild(el('p', null, 'This file has ' + txns.length + ' transactions. The free version converts the first ' + FREE_LIMIT +
        ' (' + txns[0].iso + ' to ' + txns[FREE_LIMIT - 1].iso + '). Pro will convert any number of rows, batch files and remember your bank\'s layout.'));
      var aLink = el('a', { href: '/pricing.html?from=limit#waitlist', class: 'btn small', 'data-track': 'pro_cta', 'data-track-label': 'limit' }, 'Get early access to Pro');
      ln.appendChild(aLink);
    } else ln.hidden = true;
    $('download').disabled = !txns.length;
    $('download').textContent = 'Download .' + fmt() + (txns.length > FREE_LIMIT ? ' (first ' + FREE_LIMIT + ')' : '');
  }

  function renderTable(txns, total) {
    var t = $('preview'); t.innerHTML = '';
    if (!txns.length) return;
    var thead = el('thead'), tr = el('tr');
    ['Date', 'Description', 'Memo', 'Amount'].forEach(function (h) { tr.appendChild(el('th', h === 'Amount' ? { class: 'num' } : null, h)); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el('tbody'), cur = $('currency').value;
    txns.forEach(function (x) {
      var r = el('tr');
      r.appendChild(el('td', { class: 'nowrap' }, x.iso));
      r.appendChild(el('td', null, x.payee + (x.checknum ? '  #' + x.checknum : '')));
      r.appendChild(el('td', { class: 'muted' }, x.memo));
      r.appendChild(el('td', { class: 'num ' + (x.cents < 0 ? 'neg' : 'pos') }, money(x.cents, cur)));
      tb.appendChild(r);
    });
    t.appendChild(tb);
    if (total > txns.length) {
      var cap = el('caption', null, 'Showing the first ' + txns.length + ' of ' + total + ' transactions (sorted by date)');
      t.appendChild(cap);
    }
  }

  /* ---------- output ---------- */
  function updateOutputUI() {
    var f = fmt();
    $('bidRow').hidden = f === 'ofx';
    $('syntaxRow').hidden = f !== 'ofx';
    $('routingRow').hidden = $('acctType').value === 'CREDITCARD';
    $('fmtHelp').textContent = {
      qbo: 'QBO (Web Connect) for QuickBooks Desktop and QuickBooks Online.',
      qfx: 'QFX (Web Connect) for Quicken for Windows and Mac.',
      ofx: 'Plain OFX for Xero, GnuCash, Moneydance, Banktivity, MoneyMoney, YNAB-style tools and most others.'
    }[f];
    if (state.built) $('download').textContent = 'Download .' + f + (state.built.txns.length > FREE_LIMIT ? ' (first ' + FREE_LIMIT + ')' : '');
  }

  function download() {
    if (!state.built || !state.built.txns.length) return;
    var f = fmt();
    var ledgerStr = $('ledger').value.trim();
    var ledger = ledgerStr ? Math.round(C.parseNumber(ledgerStr, $('decimal').value) * 100) : null;
    if (ledgerStr && isNaN(ledger)) { status('The ending balance is not a number.', 'error'); return; }
    try {
      var g = C.generate(state.built.txns, {
        format: f, syntax: $('syntax').value, acctType: $('acctType').value, acctId: $('acctId').value, bankId: $('routing').value,
        currency: $('currency').value, intuBid: $('intuBid').value, ledgerCents: ledger, limit: FREE_LIMIT
      });
      var blob = new Blob([g.text], { type: 'application/x-ofx' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: baseName(state.fileName) + '.' + f });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      var src = { 'entered': 'the ending balance you entered', 'balance column': 'the balance column', 'net of transactions': 'the net total of the transactions (enter an ending balance to change it)' }[g.ledgerSource];
      status('Done: ' + g.count + ' transactions saved as .' + f + '. Ending balance ' + money(g.ledgerCents, $('currency').value) + ' taken from ' + src + '.', 'ok');
      track('converted', { label: f + '-' + (g.count <= 10 ? '1-10' : g.count <= 30 ? '11-30' : '31plus') });
      if (g.truncated) track('limit_hit', { label: String(g.total > 200 ? '200plus' : g.total > 100 ? '101-200' : '31-100') });
      savePrefs();
      $('afterDownload').hidden = false;
    } catch (e) { status('Could not create the file: ' + e.message, 'error'); }
  }

  /* ---------- wiring ---------- */
  function init() {
    if (!C) return;
    var drop = $('drop'), input = $('file');
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { handleFile(input.files[0]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) { status('Batch conversion of several files is a Pro feature. Converting the first file only.', 'info'); track('pro_interest', { label: 'batch-drop' }); }
      handleFile(files[0]);
    });
    // stop the browser from opening files dropped outside the zone
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
    $('sampleBtn').addEventListener('click', function () {
      fetch(BASE + 'samples/sample-bank-statement.csv').then(function (r) { return r.arrayBuffer(); }).then(function (b) {
        state.fileName = 'sample-bank-statement.csv';
        setRows(C.csvToRows(C.decodeText(b), window.Papa), 'sample');
      });
    });
    $('sheet').addEventListener('change', function () { setRows(C.workbookToRows(window.XLSX, state.wb, $('sheet').value)); });
    $('headerRow').addEventListener('change', function () { setRows(state.rows, null, +$('headerRow').value); });
    ['dateOrder', 'decimal', 'flip', 'currency'].forEach(function (id) { $(id).addEventListener('change', refresh); });
    document.querySelectorAll('input[name="format"]').forEach(function (r) { r.addEventListener('change', updateOutputUI); });
    $('acctType').addEventListener('change', function () {
      updateOutputUI();
      if ($('acctType').value === 'CREDITCARD' && state.built && state.built.txns.length) {
        var pos = state.built.txns.filter(function (t) { return t.cents > 0; }).length;
        if (pos > state.built.txns.length / 2 && !$('flip').checked) status('Tip: most amounts are positive. If charges show as positive in your card export, tick "Flip signs".', 'info');
      }
    });
    $('download').addEventListener('click', download);
    $('reset').addEventListener('click', function () { state = { rows: null }; $('work').hidden = true; status(''); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.querySelectorAll('[data-pro]').forEach(function (b) {
      b.addEventListener('click', function () {
        track('pro_interest', { label: b.getAttribute('data-pro') });
        var n = $('proNote'); n.hidden = false;
        n.querySelector('.what').textContent = b.getAttribute('data-pro-text') || 'This';
        n.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    var p = prefs();
    if (p.format) { var r = document.querySelector('input[name="format"][value="' + p.format + '"]'); if (r) r.checked = true; }
    if (p.syntax) $('syntax').value = p.syntax;
    if (p.acctType) $('acctType').value = p.acctType;
    if (p.currency) $('currency').value = p.currency;
    if (p.bid) $('intuBid').value = p.bid;
    updateOutputUI();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
