/* Waitlist forms -> Google Apps Script web app -> Google Sheet ("waitlist" tab). Requires JavaScript. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var base = (window.RB_CONFIG && window.RB_CONFIG.base) || '/';
  var EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
  document.querySelectorAll('form[data-waitlist]').forEach(function (form) {
    var src = form.querySelector('input[name="source"]');
    if (src) src.value = (params.get('from') || location.pathname.replace(base, '').replace(/^\//, '') || 'home').slice(0, 60);
    var plan = params.get('plan');
    if (plan) { var r = form.querySelector('input[name="plan"][value="' + plan.replace(/[^a-z-]/g, '') + '"]'); if (r) r.checked = true; }
    var errBox = form.querySelector('.form-error');
    function fail(msg) { if (errBox) { errBox.textContent = msg; errBox.hidden = false; } }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (errBox) errBox.hidden = true;
      var fd = new FormData(form);
      var get = function (k) { return String(fd.get(k) || '').trim(); };
      var email = get('email');
      if (!EMAIL_RE.test(email) || email.length > 254) { fail('Please enter a valid email address.'); form.querySelector('[name="email"]').focus(); return; }
      if (!get('software')) { fail('Please choose the software you use.'); form.querySelector('[name="software"]').focus(); return; }
      var btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
      var payload = { type: 'waitlist', email: email, software: get('software'), bank_country: get('bank_country').slice(0, 100),
                      plan: get('plan'), source: get('source'), user_agent: navigator.userAgent.slice(0, 300),
                      'bot-field': get('bot-field'), form: get('form-name') };
      if (window.rbTrack) window.rbTrack('waitlist_submit', { label: get('form-name') });
      (window.rbPost ? window.rbPost(payload) : Promise.reject(new Error('no transport')))
        .then(function () { location.href = base + 'thanks.html'; })
        .catch(function () {
          if (btn) btn.disabled = false;
          fail("Sorry, we couldn't save your signup right now. Please try again in a minute.");
        });
    });
  });
  // "Choose plan" buttons on the pricing page preselect the plan in the waitlist form
  document.querySelectorAll('[data-plan]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var r = document.querySelector('#waitlist input[name="plan"][value="' + btn.getAttribute('data-plan') + '"]');
      if (r) r.checked = true;
    });
  });
})();
