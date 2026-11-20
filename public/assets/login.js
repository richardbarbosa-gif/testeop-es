(function () {
  'use strict';
  var f = document.getElementById('f'), err = document.getElementById('err'), go = document.getElementById('go');
  var totpField = document.getElementById('totpField');
  document.getElementById('toggle').addEventListener('click', function () {
    var p = document.getElementById('pass');
    var show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    this.textContent = show ? 'Ocultar' : 'Mostrar';
    this.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });
  fetch('/api/auth-info').then(function (r) { return r.json(); }).then(function (j) { if (j.totp) totpField.hidden = false; }).catch(function () {});
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var user = document.getElementById('user').value.trim();
    var pass = document.getElementById('pass').value;
    if (!user || !pass) { err.textContent = 'Informe usuário e senha.'; return; }
    go.disabled = true; go.textContent = 'Verificando…';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'orx' },
      body: JSON.stringify({ user: user, pass: pass, totp: document.getElementById('totp').value.trim() })
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        if (x.j.ok) { location.replace('/'); return; }
        if (x.j.needTotp) totpField.hidden = false;
        err.textContent = x.j.error || 'Falha no login.';
      })
      .catch(function () { err.textContent = 'Sem conexão com o servidor.'; })
      .finally(function () { go.disabled = false; go.textContent = 'Entrar'; });
  });
})();
