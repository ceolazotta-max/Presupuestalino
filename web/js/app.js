/**
 * app.js — Flujo: login → foto → OCR → revisión → datos → guardado.
 */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  var $ = function (sel) { return document.querySelector(sel); };

  var state = {
    auth: null,       // { token, email, exp }
    image: null,      // dataURL comprimido
    ocr: null,        // { fields, rx, raw }
    original: {},     // key → valor devuelto por OCR
    extras: [],       // [{ texto, ubicacion, confianza, decision: null|'keep'|'discard', originalTexto }]
    uuid: null,
    prefilledName: '',
    screen: 'login',
    reauthResolve: null
  };

  // ---------- Navegación ----------

  var ORDER = ['capture', 'review', 'extra', 'done'];

  function go(screen) {
    state.screen = screen;
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.id !== 'screen-' + screen; });
    var steps = $('#steps');
    steps.hidden = screen === 'login';
    var idx = ORDER.indexOf(screen);
    steps.querySelectorAll('li').forEach(function (li, i) {
      li.classList.toggle('active', i === idx);
      li.classList.toggle('done', i < idx);
    });
    window.scrollTo(0, 0);
  }

  function loading(on, text) {
    $('#loading').hidden = !on;
    if (text) $('#loading-text').textContent = text;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function setError(id, msg) { $(id).textContent = msg || ''; }

  // ---------- Autenticación ----------

  function decodeJwt(token) {
    var b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var json = decodeURIComponent(atob(b).split('').map(function (c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(json);
  }

  function loadGis() {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts) return resolve();
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('No se pudo cargar Google Sign-In')); };
      document.head.appendChild(s);
    });
  }

  async function initAuth() {
    if (C.isMock) {
      $('#demo-banner').hidden = false;
      $('#btn-demo-login').hidden = false;
      return;
    }
    var saved = sessionStorage.getItem('auth');
    if (saved) {
      try {
        var a = JSON.parse(saved);
        if (a.exp - 120 > Date.now() / 1000) { setAuth(a); go('capture'); }
      } catch (e) { sessionStorage.removeItem('auth'); }
    }
    try {
      await loadGis();
      google.accounts.id.initialize({
        client_id: C.OAUTH_CLIENT_ID,
        callback: onCredential,
        hd: C.ALLOWED_DOMAIN || undefined,
        auto_select: true,
        use_fedcm_for_prompt: true
      });
      var opts = { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'es' };
      google.accounts.id.renderButton($('#gis-btn'), opts);
      google.accounts.id.renderButton($('#gis-btn-reauth'), opts);
      if (!state.auth) google.accounts.id.prompt();
    } catch (e) {
      setError('#login-error', e.message);
    }
  }

  function onCredential(resp) {
    var claims;
    try { claims = decodeJwt(resp.credential); } catch (e) { return setError('#login-error', 'Respuesta de login inválida'); }
    if (C.ALLOWED_DOMAIN && claims.hd !== C.ALLOWED_DOMAIN) {
      return setError('#login-error', 'Usá tu cuenta corporativa (@' + C.ALLOWED_DOMAIN + ').');
    }
    setAuth({ token: resp.credential, email: claims.email, exp: claims.exp });
    sessionStorage.setItem('auth', JSON.stringify(state.auth));
    setError('#login-error', '');
    if (state.reauthResolve) {
      $('#reauth').hidden = true;
      state.reauthResolve(state.auth.token);
      state.reauthResolve = null;
    } else if (state.screen === 'login') {
      go('capture');
    }
  }

  function setAuth(a) {
    state.auth = a;
    $('#user').hidden = false;
    $('#user-email').textContent = a.email;
  }

  function getToken() {
    if (C.isMock) return Promise.resolve('demo');
    if (state.auth && state.auth.exp - 60 > Date.now() / 1000) return Promise.resolve(state.auth.token);
    return new Promise(function (resolve) {
      state.reauthResolve = resolve;
      $('#reauth').hidden = false;
      try { google.accounts.id.prompt(); } catch (e) { /* botón visible igual */ }
    });
  }

  function logout() {
    sessionStorage.removeItem('auth');
    state.auth = null;
    if (!C.isMock && window.google && google.accounts) google.accounts.id.disableAutoSelect();
    $('#user').hidden = true;
    resetFlow();
    go('login');
  }

  // Ejecuta llamada a API; si el backend dice 401, pide re-login y reintenta una vez.
  async function withAuth(fn) {
    var token = await getToken();
    try {
      return await fn(token);
    } catch (e) {
      if (e.code === 401 && !C.isMock) {
        state.auth = null;
        sessionStorage.removeItem('auth');
        token = await getToken();
        return fn(token);
      }
      throw e;
    }
  }

  // ---------- Captura ----------

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, C.MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.round(img.naturalWidth * scale);
          var h = Math.round(img.naturalHeight * scale);
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', C.JPEG_QUALITY));
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la imagen. Probá con JPG o PNG.'));
      };
      img.src = url;
    });
  }

  async function onFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('#capture-error', '');
    loading(true, 'Preparando imagen…');
    try {
      state.image = await compressImage(file);
      state.uuid = newUuid();
      $('#preview-img').src = state.image;
      $('#capture-empty').hidden = true;
      $('#capture-preview').hidden = false;
    } catch (err) {
      setError('#capture-error', err.message);
    } finally {
      loading(false);
    }
  }

  function retake() {
    state.image = null;
    $('#capture-preview').hidden = true;
    $('#capture-empty').hidden = false;
  }

  function newUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.from(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  async function runOcr() {
    setError('#capture-error', '');
    loading(true, 'Reconociendo receta… (puede tardar unos segundos)');
    try {
      var res = await withAuth(function (t) { return Api.ocr(t, state.image); });
      state.ocr = res;
      renderReview();
      go('review');
    } catch (e) {
      setError('#capture-error', e.message);
    } finally {
      loading(false);
    }
  }

  // ---------- Revisión ----------

  var GROUP_TITLES = { encabezado: 'Paciente y médico', lejos: 'Lejos', cerca: 'Cerca', otros: 'Otros' };
  var PARAMS = ['esfera', 'cilindro', 'eje'];
  var PARAM_SHORT = { esfera: 'Esf', cilindro: 'Cil', eje: 'Eje' };

  function makeInput(field, cell) {
    var c = cell || { valor: null, confianza: 'baja' };
    var val = c.valor == null ? '' : String(c.valor);
    var el = field.type === 'longtext' ? document.createElement('textarea') : document.createElement('input');
    if (el.tagName === 'INPUT') {
      el.type = 'text';
      if (['esfera', 'cilindro', 'adicion'].indexOf(field.type) >= 0) el.inputMode = 'decimal';
      if (field.type === 'eje') el.inputMode = 'numeric';
    }
    el.value = val;
    el.dataset.key = field.key;
    el.dataset.type = field.type;
    el.setAttribute('aria-label', field.label);
    el.autocomplete = 'off';
    if (c.confianza === 'baja' || c.confianza === 'media') el.classList.add('conf-' + c.confianza);
    state.original[field.key] = val;
    el.addEventListener('input', function () { onRxInput(el); });
    return el;
  }

  function onRxInput(el) {
    el.classList.toggle('edited', el.value !== state.original[el.dataset.key]);
    validateEl(el);
    updateGroupWarnings(el.closest('.rx-group'));
  }

  function validateEl(el) {
    var msg = Validate.validateRxValue(el.dataset.type, el.value);
    el.classList.toggle('invalid', !!msg);
    el.title = msg;
    el.dataset.warn = msg;
    return msg;
  }

  function updateGroupWarnings(group) {
    var ul = group.querySelector('.group-warn');
    ul.innerHTML = '';
    group.querySelectorAll('[data-warn]').forEach(function (el) {
      if (!el.dataset.warn) return;
      var li = document.createElement('li');
      li.textContent = el.getAttribute('aria-label') + ': ' + el.dataset.warn;
      ul.appendChild(li);
    });
  }

  function renderReview() {
    var fields = state.ocr.fields;
    var rx = state.ocr.rx || {};
    var campos = rx.campos || {};
    state.original = {};
    $('#review-img').src = state.image;
    $('#not-rx-warning').hidden = rx.es_receta_optica !== false;

    var root = $('#rx-form');
    root.innerHTML = '';
    Object.keys(GROUP_TITLES).forEach(function (g) {
      var gFields = fields.filter(function (f) { return f.group === g; });
      if (!gFields.length) return;
      var box = document.createElement('div');
      box.className = 'rx-group';
      var h = document.createElement('h4');
      h.textContent = GROUP_TITLES[g];
      box.appendChild(h);

      if (g === 'lejos' || g === 'cerca') {
        var table = document.createElement('table');
        table.className = 'rx-table';
        var thead = '<thead><tr><th></th>' + PARAMS.map(function (p) { return '<th scope="col">' + PARAM_SHORT[p] + '</th>'; }).join('') + '</tr></thead>';
        table.innerHTML = thead;
        var tbody = document.createElement('tbody');
        ['OD', 'OI'].forEach(function (eye) {
          var tr = document.createElement('tr');
          var th = document.createElement('th');
          th.scope = 'row';
          th.textContent = eye;
          tr.appendChild(th);
          PARAMS.forEach(function (p) {
            var f = gFields.find(function (x) { return x.eye === eye && x.param === p; });
            var td = document.createElement('td');
            if (f) td.appendChild(makeInput(f, campos[f.key]));
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        box.appendChild(table);
      } else {
        var list = document.createElement('div');
        list.className = 'rx-list';
        gFields.forEach(function (f) {
          var label = document.createElement('label');
          label.className = 'field' + (f.type === 'longtext' ? ' wide' : '');
          var span = document.createElement('span');
          span.textContent = f.label;
          label.appendChild(span);
          label.appendChild(makeInput(f, campos[f.key]));
          list.appendChild(label);
        });
        box.appendChild(list);
      }
      var warn = document.createElement('ul');
      warn.className = 'group-warn';
      box.appendChild(warn);
      root.appendChild(box);
      box.querySelectorAll('[data-key]').forEach(validateEl);
      updateGroupWarnings(box);
    });

    state.extras = (rx.anotaciones_extra || []).map(function (a) {
      return { texto: a.texto || '', originalTexto: a.texto || '', ubicacion: a.ubicacion || '', confianza: a.confianza || 'baja', decision: null };
    });
    renderExtras();
    setError('#review-error', '');
  }

  function renderExtras() {
    var root = $('#extras-list');
    root.innerHTML = '';
    if (!state.extras.length) {
      root.innerHTML = '<p class="empty-extras">No se detectaron anotaciones extra.</p>';
      return;
    }
    state.extras.forEach(function (x, i) {
      var item = document.createElement('div');
      item.className = 'extra-item ' + (x.decision || 'pending');
      var ta = document.createElement('textarea');
      ta.rows = 2;
      ta.value = x.texto;
      ta.setAttribute('aria-label', 'Anotación ' + (i + 1));
      ta.addEventListener('input', function () { x.texto = ta.value; });
      var meta = document.createElement('div');
      meta.className = 'extra-meta';
      meta.textContent = [x.ubicacion, x.confianza && ('confianza ' + x.confianza)].filter(Boolean).join(' · ');
      var actions = document.createElement('div');
      actions.className = 'extra-actions';
      [['keep', 'Guardar'], ['discard', 'Descartar']].forEach(function (d) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost small ' + d[0] + '-btn';
        b.textContent = d[1];
        b.setAttribute('aria-pressed', String(x.decision === d[0]));
        b.addEventListener('click', function () { x.decision = d[0]; renderExtras(); });
        actions.appendChild(b);
      });
      item.appendChild(ta);
      item.appendChild(meta);
      item.appendChild(actions);
      root.appendChild(item);
    });
  }

  function addExtra() {
    state.extras.push({ texto: '', originalTexto: '', ubicacion: 'agregada por usuario', confianza: '', decision: 'keep' });
    renderExtras();
    var tas = $('#extras-list').querySelectorAll('textarea');
    tas[tas.length - 1].focus();
  }

  function collectRx() {
    var out = {};
    document.querySelectorAll('#rx-form [data-key]').forEach(function (el) { out[el.dataset.key] = el.value.trim(); });
    return out;
  }

  function wasCorrected(rxValues) {
    var fieldsChanged = Object.keys(rxValues).some(function (k) { return rxValues[k] !== (state.original[k] || '').trim(); });
    var extrasChanged = state.extras.some(function (x) { return x.texto !== x.originalTexto || x.originalTexto === ''; });
    return fieldsChanged || extrasChanged;
  }

  function toExtra() {
    var pending = state.extras.filter(function (x) { return !x.decision; }).length;
    if (pending) {
      setError('#review-error', 'Decidí Guardar o Descartar en ' + pending + ' anotación(es) extra.');
      $('#extras-list .pending').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var warns = document.querySelectorAll('#rx-form .invalid').length;
    if (warns && !confirm('Hay ' + warns + ' valor(es) con advertencias. ¿Continuar igual?')) return;
    setError('#review-error', '');
    var paciente = (collectRx().paciente || '').trim();
    var nameInput = $('#extra-form').elements[C.PHOTO_NAME_FIELD];
    if (nameInput && paciente && (!nameInput.value.trim() || nameInput.value === state.prefilledName)) {
      nameInput.value = paciente;
      state.prefilledName = paciente;
    }
    go('extra');
    var first = $('#extra-fields input, #extra-fields textarea');
    if (first) first.focus();
  }

  // ---------- Datos adicionales ----------

  function renderExtraForm() {
    var root = $('#extra-fields');
    root.innerHTML = '';
    C.EXTRA_FIELDS.forEach(function (f) {
      var label = document.createElement('label');
      label.className = 'field';
      if (f.showWhen) {
        label.dataset.showField = f.showWhen.field;
        label.dataset.showValue = f.showWhen.value;
      }
      var span = document.createElement('span');
      span.innerHTML = '';
      span.textContent = f.label;
      if (f.required) {
        var req = document.createElement('b');
        req.className = 'req';
        req.textContent = ' *';
        span.appendChild(req);
      }
      var el;
      if (f.type === 'textarea') {
        el = document.createElement('textarea');
      } else if (f.type === 'select') {
        el = document.createElement('select');
        [''].concat(f.options || []).forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o || '— Elegir —';
          el.appendChild(opt);
        });
        el.addEventListener('change', syncConditionalFields);
      } else {
        el = document.createElement('input');
        el.type = f.type || 'text';
      }
      el.name = f.key;
      el.dataset.label = f.label;
      if (f.required) el.required = true;
      if (f.autocomplete) el.autocomplete = f.autocomplete;
      el.maxLength = f.type === 'textarea' ? 1000 : 200;
      label.appendChild(span);
      label.appendChild(el);
      root.appendChild(label);
    });
    syncConditionalFields();
  }

  function syncConditionalFields() {
    var form = $('#extra-form');
    document.querySelectorAll('#extra-fields label[data-show-field]').forEach(function (label) {
      var ctrl = form.elements[label.dataset.showField];
      var show = !!ctrl && ctrl.value === label.dataset.showValue;
      label.hidden = !show;
      var input = label.querySelector('input, textarea, select');
      if (input) {
        input.disabled = !show;
        if (!show) input.value = '';
      }
    });
  }

  async function save(ev) {
    ev.preventDefault();
    var form = $('#extra-form');
    if (!form.reportValidity()) return;
    setError('#extra-error', '');

    var extraFields = C.EXTRA_FIELDS.map(function (f) {
      var el = form.elements[f.key];
      return { key: f.key, label: f.label, value: (el && !el.disabled) ? el.value.trim() : '' };
    });
    var nameField = extraFields.find(function (f) { return f.key === C.PHOTO_NAME_FIELD; });
    var rxValues = collectRx();
    var payload = {
      uuid: state.uuid,
      image: state.image,
      photoName: nameField ? nameField.value : '',
      rx: rxValues,
      extras: state.extras.filter(function (x) { return x.decision === 'keep' && x.texto.trim(); })
        .map(function (x) { return x.texto.trim(); }),
      extraFields: extraFields,
      isRx: !(state.ocr.rx && state.ocr.rx.es_receta_optica === false),
      corrected: wasCorrected(rxValues),
      raw: state.ocr.raw || ''
    };

    $('#btn-save').disabled = true;
    loading(true, 'Guardando en Drive y Sheets…');
    try {
      var res = await withAuth(function (t) { return Api.save(Object.assign({ idToken: t }, payload)); });
      showDone(res);
    } catch (e) {
      setError('#extra-error', e.message + ' (podés reintentar: no se duplica)');
    } finally {
      loading(false);
      $('#btn-save').disabled = false;
    }
  }

  function showDone(res) {
    var parts = [];
    if (res.duplicate) parts.push('Ya estaba guardada (fila ' + res.fila + ').');
    else parts.push('Fila ' + res.fila + ' del Sheet.');
    if (res.fotoNombre) parts.push('Foto: ' + res.fotoNombre);
    if (res.demo) parts.push('(Demo: no se guardó nada)');
    $('#done-detail').textContent = parts.join(' ');
    var link = $('#done-link');
    link.hidden = !res.fotoUrl;
    if (res.fotoUrl) link.href = res.fotoUrl;
    go('done');
  }

  function resetFlow() {
    state.image = null;
    state.ocr = null;
    state.extras = [];
    state.original = {};
    state.uuid = null;
    state.prefilledName = '';
    $('#extra-form').reset();
    syncConditionalFields();
    retake();
  }

  // ---------- Zoom ----------

  function openZoom() {
    $('#zoom-img').src = state.image;
    $('#zoom').hidden = false;
  }

  // ---------- Init ----------

  function bind() {
    $('#btn-demo-login').addEventListener('click', function () {
      setAuth({ token: 'demo', email: 'demo@ejemplo.com', exp: Date.now() / 1000 + 86400 });
      go('capture');
    });
    $('#btn-logout').addEventListener('click', logout);
    $('#in-camera').addEventListener('change', onFile);
    $('#in-file').addEventListener('change', onFile);
    $('#btn-retake').addEventListener('click', retake);
    $('#btn-ocr').addEventListener('click', runOcr);
    $('#review-img').addEventListener('click', openZoom);
    $('#zoom-close').addEventListener('click', function () { $('#zoom').hidden = true; });
    $('#btn-add-extra').addEventListener('click', addExtra);
    $('#btn-back-capture').addEventListener('click', function () { retake(); go('capture'); });
    $('#btn-to-extra').addEventListener('click', toExtra);
    $('#btn-back-review').addEventListener('click', function () { go('review'); });
    $('#extra-form').addEventListener('submit', save);
    $('#btn-new').addEventListener('click', function () { resetFlow(); go('capture'); });
    window.addEventListener('beforeunload', function (e) {
      if (state.screen === 'review' || state.screen === 'extra') { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('#zoom').hidden = true; });
  }

  function registerSw() {
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW:', e); });
    }
  }

  bind();
  renderExtraForm();
  go('login');
  initAuth();
  registerSw();
})();
