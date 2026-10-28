/* Anonymous usage events -> Google Apps Script web app -> Google Sheet ("events" tab).
 * Each event: name (+ short label), page path, referrer, random per-tab session id. No cookies, no file data,
 * no file names, amounts or descriptions. Apps Script web apps don't answer CORS preflights, so we send
 * text/plain JSON with sendBeacon / fetch(no-cors): the browser fires and forgets. */
(function () {
  'use strict';
  var cfg = window.RB_CONFIG || {};
  var endpoint = cfg.endpoint || '';
  var live = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(endpoint) && endpoint.indexOf('REPLACE_WITH') < 0;
  function sid() {
    try {
      var s = sessionStorage.getItem('rb_sid');
      if (!s) {
        s = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + '-' + Date.now().toString(36);
        sessionStorage.setItem('rb_sid', s);
      }
      return s;
    } catch (e) { return ''; }
  }
  function post(payload) {
    if (!live && !window.RB_TEST_ENDPOINT) return Promise.reject(new Error('endpoint not configured'));
    var url = window.RB_TEST_ENDPOINT || endpoint;
    var body = JSON.stringify(payload);
    return fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, credentials: 'omit',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body });
  }
  window.rbPost = post;   // shared with forms.js
  window.rbTrack = function (name, props) {
    try {
      var label = props && props.label ? ':' + String(props.label).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
      var ev = { type: 'event', event: String(name).slice(0, 40) + label, page: location.pathname,
                 referrer: document.referrer || '', session_id: sid() };
      if (window.RB_DEBUG) console.log('[rbTrack]', ev);
      post(ev).catch(function () {});
    } catch (e) { /* analytics must never break the page */ }
  };
  // one pageview per page load
  window.rbTrack('pageview');
  // declarative hooks: <a data-track="pricing_cta" data-track-label="lifetime">
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-track]');
    if (el) window.rbTrack(el.getAttribute('data-track'), { label: el.getAttribute('data-track-label') || '' });
  });
})();
