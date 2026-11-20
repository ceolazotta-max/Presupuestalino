/**
 * app.js — Flujo: login → foto → OCR → revisión (guarda INCOMPLETO) → datos → presupuesto → imprimir/WA → cierre de venta.
 */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  var Q = window.Quote;
  var $ = function (sel) { return document.querySelector(sel); };
  var DRAFT_KEY = 'presupuestalino_draft_v1';

  function defaultQuoteEye() {
    return {
      mode: 'catalog',
      codigo: '',
      price: 0,
      manual: { nombre: '', tipo: 'Stock', diseno: 'Monofocal', indice: '1.50', tratamiento: '', saveToCatalog: false }
    };
  }

  function defaultQuoteItem(uso) {
    return {
      uso: uso || 'lejos',
      eyesMode: 'both',
      od: defaultQuoteEye(),
      oi: defaultQuoteEye()
    };
  }

  function defaultQuoteState() {
    return {
      items: [defaultQuoteItem('lejos')],
      frameModeSelect: 'none',
      frame: { mode: 'none', rimType: 'completo', detail: '', price: 0 },
      discount: 0,
      discountNote: '',
      deposit: 0
    };
  }

  function normalizeQuoteEye(eye) {
    var e = Object.assign(defaultQuoteEye(), eye || {});
    e.manual = Object.assign(defaultQuoteEye().manual, (eye && eye.manual) || {});
    return e;
  }

  function normalizeQuoteState(raw) {
    var q = Object.assign(defaultQuoteState(), raw || {});
    q.frame = Object.assign(defaultQuoteState().frame, (raw && raw.frame) || {});
    if (!Array.isArray(q.items) || !q.items.length) {
      var legacy = defaultQuoteItem((raw && raw.uso) || 'lejos');
      if (raw && raw.eyesMode) legacy.eyesMode = raw.eyesMode;
      if (raw && raw.od) legacy.od = normalizeQuoteEye(raw.od);
      if (raw && raw.oi) legacy.oi = normalizeQuoteEye(raw.oi);
      q.items = [legacy];
    } else {
      q.items = q.items.map(function (it) {
        return {
          uso: (it && it.uso) || 'lejos',
          eyesMode: (it && it.eyesMode) || 'both',
          od: normalizeQuoteEye(it && it.od),
          oi: normalizeQuoteEye(it && it.oi)
        };
      });
    }
    return q;
  }

  function defaultTimers() {
    return { startMs: 0, stepStartMs: 0, inicioIso: '', paso1Sec: 0, paso2Sec: 0, paso3Sec: 0, paso4Sec: 0, cierreSec: 0 };
  }

  var state = {
    auth: null,       // { token, email, exp }
    image: null,      // dataURL comprimido
    ocr: null,        // { fields, rx, raw }
    original: {},     // key → valor devuelto por OCR
    extras: [],       // [{ texto, ubicacion, confianza, decision: null|'keep'|'discard', originalTexto }]
    uuid: null,
    prefilledName: '',
    catalog: Q.SEED_CATALOG.slice(),
    paymentConfig: C.PAYMENT_CONFIG || Q.DEFAULT_PAYMENT_CONFIG,
    catalogLoaded: false,
    quoteInitialized: false,
    budgetIssued: false,
    photoUploaded: false,
    inFlightSave: null,
    lastResult: null,
    quote: defaultQuoteState(),
    timers: defaultTimers(),
    screen: 'login',
    reauthResolve: null
  };

  // ---------- Cronómetro & Borrador ----------

  function startTimers() {
    var now = Date.now();
    state.timers = {
      startMs: now,
      stepStartMs: now,
      inicioIso: new Date(now).toISOString(),
      paso1Sec: 0, paso2Sec: 0, paso3Sec: 0, paso4Sec: 0, cierreSec: 0
    };
  }

  function markStep(key) {
    if (!state.timers.stepStartMs) return;
    var diff = Math.max(0, Math.round((Date.now() - state.timers.stepStartMs) / 1000));
    state.timers[key] = (state.timers[key] || 0) + diff;
    state.timers.stepStartMs = Date.now();
  }

  function stepKeyForScreen(scr) {
    if (scr === 'review') return 'paso2Sec';
    if (scr === 'extra') return 'paso3Sec';
    if (scr === 'quote') return 'paso4Sec';
    if (scr === 'done') return 'cierreSec';
    return 'paso1Sec';
  }

  function buildTimingsPayload() {
    var t = state.timers;
    var totalSec = t.startMs ? Math.max(0, Math.round((Date.now() - t.startMs) / 1000)) : 0;
    return {
      inicioIso: t.inicioIso,
      paso1Sec: t.paso1Sec,
      paso2Sec: t.paso2Sec,
      paso3Sec: t.paso3Sec,
      paso4Sec: t.paso4Sec,
      cierreSec: t.cierreSec,
      totalSec: totalSec
    };
  }

  function saveDraft() {
    if (!state.uuid || !state.image || !state.ocr) return;
    if (['review', 'extra', 'quote', 'done'].indexOf(state.screen) < 0) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        uuid: state.uuid,
        image: state.image,
        ocr: state.ocr,
        rxValues: collectRx(),
        extras: state.extras,
        extraMap: getExtraMap(),
        prefilledName: state.prefilledName,
        quote: state.quote,
        quoteInitialized: state.quoteInitialized,
        budgetIssued: state.budgetIssued,
        photoUploaded: state.photoUploaded,
        lastResult: state.lastResult,
        timers: state.timers,
        screen: state.screen
      }));
    } catch (e) { /* cuota llena o storage bloqueado */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
  }

  function restoreDraftIfAny() {
    var raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      var d = JSON.parse(raw);
      if (!d || !d.uuid || !d.image || !d.ocr || ['review', 'extra', 'quote', 'done'].indexOf(d.screen) < 0) return false;
      state.uuid = d.uuid;
      state.image = d.image;
      state.ocr = d.ocr;
      state.prefilledName = d.prefilledName || '';
      state.quote = normalizeQuoteState(d.quote);
      state.quoteInitialized = Boolean(d.quoteInitialized);
      state.budgetIssued = Boolean(d.budgetIssued);
      state.photoUploaded = Boolean(d.photoUploaded);
      state.lastResult = d.lastResult || null;
      state.timers = Object.assign(defaultTimers(), d.timers || {});
      if (!state.timers.stepStartMs) state.timers.stepStartMs = Date.now();

      renderReview();
      if (d.rxValues) {
        document.querySelectorAll('#rx-form [data-key]').forEach(function (el) {
          if (d.rxValues[el.dataset.key] !== undefined) {
            el.value = d.rxValues[el.dataset.key];
            onRxInput(el);
          }
        });
      }
      if (Array.isArray(d.extras)) {
        state.extras = d.extras;
        renderExtras();
      }
      if (d.extraMap) {
        var form = $('#extra-form');
        C.EXTRA_FIELDS.forEach(function (f) {
          var el = form.elements[f.key];
          if (el && d.extraMap[f.key] !== undefined) el.value = d.extraMap[f.key];
        });
        syncConditionalFields();
      }
      if (d.screen === 'quote') {
        syncQuoteControls();
        go('quote');
      } else if (d.screen === 'done') {
        syncQuoteControls();
        showDone(state.lastResult || { fila: '—' });
      } else {
        go(d.screen);
      }
      toast('Se recuperó un presupuesto pendiente. Completalo o abandoná con motivo.');
      return true;
    } catch (e) {
      clearDraft();
      return false;
    }
  }

  // ---------- Navegación ----------

  var ORDER = ['capture', 'review', 'extra', 'quote', 'done'];

  function go(screen) {
    state.screen = screen;
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.id !== 'screen-' + screen; });
    var steps = $('#steps');
    steps.hidden = screen === 'login';
    $('#btn-abandon').hidden = ['review', 'extra', 'quote', 'done'].indexOf(screen) < 0;
    var idx = ORDER.indexOf(screen);
    steps.querySelectorAll('li').forEach(function (li, i) {
      li.classList.toggle('active', i === idx);
      li.classList.toggle('done', i < idx);
    });
    window.scrollTo(0, 0);
    saveDraft();
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
        if (a.exp - 120 > Date.now() / 1000) {
          setAuth(a);
          if (!restoreDraftIfAny()) go('capture');
        }
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
      if (!restoreDraftIfAny()) go('capture');
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
      clearDraft();
      state.image = await compressImage(file);
      state.ocr = null;
      state.extras = [];
      state.original = {};
      state.uuid = newUuid();
      state.prefilledName = '';
      state.quoteInitialized = false;
      state.budgetIssued = false;
      state.photoUploaded = false;
      state.lastResult = null;
      state.quote = defaultQuoteState();
      $('#extra-form').reset();
      syncConditionalFields();
      startTimers();
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
      markStep('paso1Sec');
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
    el.addEventListener('input', function () { onRxInput(el); saveDraft(); });
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
      ta.addEventListener('input', function () { x.texto = ta.value; saveDraft(); });
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
        b.addEventListener('click', function () { x.decision = d[0]; renderExtras(); saveDraft(); });
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
    saveDraft();
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

  function saveIncompleteInBackground(rxValues) {
    var paciente = (rxValues.paciente || '').trim();
    var payload = {
      uuid: state.uuid,
      stage: 'incompleto',
      image: state.photoUploaded ? '' : state.image,
      photoName: paciente || 'Pendiente',
      rx: rxValues,
      extras: state.extras.filter(function (x) { return x.decision === 'keep' && x.texto.trim(); })
        .map(function (x) { return x.texto.trim(); }),
      extraFields: collectExtraFields(),
      isRx: !(state.ocr.rx && state.ocr.rx.es_receta_optica === false),
      corrected: wasCorrected(rxValues),
      timings: buildTimingsPayload()
    };
    var p = withAuth(function (tok) { return Api.save(Object.assign({ idToken: tok }, payload)); })
      .then(function (res) {
        state.photoUploaded = true;
        state.lastResult = res;
        saveDraft();
        return res;
      })
      .catch(function (e) {
        console.warn('Guardado parcial pendiente:', e);
      })
      .finally(function () {
        if (state.inFlightSave === p) state.inFlightSave = null;
      });
    state.inFlightSave = p;
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

    markStep('paso2Sec');
    var rxValues = collectRx();
    var paciente = (rxValues.paciente || '').trim();
    var nameInput = $('#extra-form').elements[C.PHOTO_NAME_FIELD];
    if (nameInput && paciente && (!nameInput.value.trim() || nameInput.value === state.prefilledName)) {
      nameInput.value = paciente;
      state.prefilledName = paciente;
    }
    saveIncompleteInBackground(rxValues);
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
        label.dataset.showValues = JSON.stringify(f.showWhen.values || [f.showWhen.value]);
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
        el.addEventListener('change', function () { syncConditionalFields(); saveDraft(); });
      } else {
        el = document.createElement('input');
        el.type = f.type || 'text';
      }
      el.name = f.key;
      el.dataset.label = f.label;
      el.autocomplete = 'off';
      if (f.required) el.required = true;
      el.maxLength = f.type === 'textarea' ? 1000 : 200;
      el.addEventListener('input', saveDraft);
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
      var vals = JSON.parse(label.dataset.showValues || '[]');
      var show = !!ctrl && vals.indexOf(ctrl.value) >= 0;
      label.hidden = !show;
      var input = label.querySelector('input, textarea, select');
      if (input) {
        input.disabled = !show;
        if (!show) input.value = '';
      }
    });
  }

  function collectExtraFields() {
    var form = $('#extra-form');
    return C.EXTRA_FIELDS.map(function (f) {
      var el = form.elements[f.key];
      return { key: f.key, label: f.label, value: (el && !el.disabled) ? el.value.trim() : '' };
    });
  }

  // ---------- Presupuesto (Paso 4) ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getExtraMap() {
    var form = $('#extra-form');
    var out = {};
    C.EXTRA_FIELDS.forEach(function (f) {
      var el = form.elements[f.key];
      out[f.key] = (el && !el.disabled) ? el.value.trim() : '';
    });
    return out;
  }

  async function ensureCatalog() {
    if (state.catalogLoaded) return;
    loading(true, 'Cargando catálogo y medios de pago…');
    try {
      var res = await withAuth(function (t) { return Api.catalog(t); });
      if (res && Array.isArray(res.items) && res.items.length) state.catalog = res.items;
      if (res && res.paymentConfig) state.paymentConfig = res.paymentConfig;
      state.catalogLoaded = true;
    } catch (e) {
      toast('Usando catálogo base local (' + e.message + ')');
    } finally {
      loading(false);
    }
  }

  async function toQuote(ev) {
    ev.preventDefault();
    var form = $('#extra-form');
    C.EXTRA_FIELDS.forEach(function (f) {
      var el = form.elements[f.key];
      if (el && !el.disabled && typeof el.value === 'string') el.value = el.value.trim();
    });
    if (!form.reportValidity()) return;
    setError('#extra-error', '');
    markStep('paso3Sec');
    await ensureCatalog();
    var rx = collectRx();
    if (!state.quoteInitialized) {
      state.quote = defaultQuoteState();
      state.quote.items[0].uso = Q.inferDefaultUso(rx);
      state.quoteInitialized = true;
    }
    syncQuoteControls();
    go('quote');
  }

  function formatEyeRxLine(eyeRx) {
    if (!eyeRx.hasGrad) return 'Sin graduación cargada (neutro)';
    var orig = 'Receta: Esf ' + Q.fmtDiopter(eyeRx.rawEsf) + ' · Cil ' + Q.fmtDiopter(eyeRx.rawCil) + ' · Eje ' + Q.fmtAxis(eyeRx.rawEje);
    if (eyeRx.add) orig += ' · Add ' + Q.fmtDiopter(eyeRx.add);
    if (eyeRx.hasPrisma) orig += ' · Prisma ' + eyeRx.prisma;
    if (eyeRx.transposed) {
      orig += '  ⇒  Lab (-cil): ' + Q.fmtDiopter(eyeRx.esf_t) + ' ' + Q.fmtDiopter(eyeRx.cil_t) + ' x ' + Q.fmtAxis(eyeRx.eje_t);
    }
    return orig;
  }

  function createEyeCardHtml(eye) {
    var upper = eye === 'od' ? 'OD (Ojo Derecho)' : 'OI (Ojo Izquierdo)';
    var short = eye.toUpperCase();
    var ph = eye === 'od' ? 'Ej. Orgánico 1.60 Blue Cut' : 'Ej. Tallado 1.67 Antirreflejo';
    return '<div class="eye-card" data-eye="' + eye + '">' +
      '<div class="eye-head">' +
      '<h3>½ Par ' + upper + '</h3>' +
      '<span class="badge" data-role="badge"></span>' +
      '</div>' +
      '<p class="rx-summary" data-role="rx"></p>' +
      '<label class="field"><span>Cristal ' + short + '</span><select data-role="prod"></select></label>' +
      '<div class="manual-box" data-role="manual-box" hidden>' +
      '<label class="field"><span>Nombre / Descripción *</span><input type="text" maxlength="120" data-role="man-nombre" placeholder="' + ph + '"></label>' +
      '<div class="rx-list">' +
      '<label class="field"><span>Tipo</span><select data-role="man-tipo"><option value="Stock">Stock</option><option value="Rango Extendido">Rango Extendido</option><option value="Laboratorio">Laboratorio</option></select></label>' +
      '<label class="field"><span>Diseño</span><select data-role="man-diseno"><option value="Monofocal">Monofocal</option><option value="Bifocal">Bifocal</option><option value="Multifocal">Multifocal</option><option value="Ocupacional">Ocupacional</option></select></label>' +
      '<label class="field"><span>Índice</span><select data-role="man-indice"><option value="1.50">1.50</option><option value="1.56">1.56</option><option value="1.59">1.59 Poly</option><option value="1.60">1.60</option><option value="1.67">1.67</option><option value="1.74">1.74</option></select></label>' +
      '<label class="field"><span>Tratamiento</span><input type="text" maxlength="40" data-role="man-trat" placeholder="Blanco / AR / Blue Cut / Foto"></label>' +
      '</div>' +
      '<label class="check-field"><input type="checkbox" data-role="man-save"> <span>Guardar este cristal en el Catálogo para próximas veces</span></label>' +
      '</div>' +
      '<label class="field"><span>Precio ½ par ' + short + ' ($)</span><input type="number" min="0" step="100" inputmode="numeric" data-role="price"></label>' +
      '</div>';
  }

  function renderQuoteItemBlocks() {
    var root = $('#q-items-list');
    var items = state.quote.items;
    if (root.children.length === items.length) return;
    root.innerHTML = '';
    items.forEach(function (_, idx) {
      var block = document.createElement('div');
      block.className = 'quote-item-block';
      block.dataset.itemIdx = String(idx);
      block.innerHTML =
        '<div class="quote-item-head">' +
        '<span class="quote-item-title">Opción ' + (idx + 1) + '</span>' +
        '<button class="btn ghost btn-remove-item" type="button" data-role="remove">✕ Eliminar opción</button>' +
        '</div>' +
        '<div class="rx-list">' +
        '<label class="field"><span>Uso del anteojo</span><select data-role="uso">' +
        '<option value="lejos">Lejos</option>' +
        '<option value="cerca">Cerca</option>' +
        '<option value="multifocal">Multifocal</option>' +
        '<option value="bifocal">Bifocal</option>' +
        '<option value="ocupacional">Ocupacional</option>' +
        '</select></label>' +
        '<label class="field"><span>Ojos a cotizar</span><select data-role="eyes">' +
        '<option value="both">Ambos ojos (OD + OI)</option>' +
        '<option value="od">Solo OD (½ par derecho)</option>' +
        '<option value="oi">Solo OI (½ par izquierdo)</option>' +
        '</select></label>' +
        '</div>' +
        '<div class="eyes-grid">' + createEyeCardHtml('od') + createEyeCardHtml('oi') + '</div>';

      block.querySelector('[data-role="remove"]').addEventListener('click', function () {
        if (state.quote.items.length <= 1) return;
        state.quote.items.splice(idx, 1);
        syncQuoteControls();
        saveDraft();
      });
      block.querySelector('[data-role="uso"]').addEventListener('change', function (e) {
        var item = state.quote.items[idx];
        item.uso = e.target.value;
        var dis = Q.USO_TO_DISENO[item.uso] || 'Monofocal';
        item.od.manual.diseno = dis;
        item.oi.manual.diseno = dis;
        if (dis !== 'Monofocal') {
          item.od.manual.tipo = 'Laboratorio';
          item.oi.manual.tipo = 'Laboratorio';
        }
        syncQuoteControls();
        saveDraft();
      });
      block.querySelector('[data-role="eyes"]').addEventListener('change', function (e) {
        state.quote.items[idx].eyesMode = e.target.value;
        syncQuoteControls();
        saveDraft();
      });
      ['od', 'oi'].forEach(function (eye) {
        var card = block.querySelector('[data-eye="' + eye + '"]');
        card.querySelector('[data-role="prod"]').addEventListener('change', function () {
          onEyeSelectChange(block, idx, eye);
        });
        ['man-nombre', 'man-tipo', 'man-diseno', 'man-indice', 'man-trat', 'man-save', 'price'].forEach(function (role) {
          var el = card.querySelector('[data-role="' + role + '"]');
          var evt = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
          el.addEventListener(evt, function () {
            readManualAndPrice(block, idx, eye);
            refreshQuotePreview();
          });
        });
      });

      root.appendChild(block);
    });
  }

  function syncEyeCard(block, item, eye, eyeRx, pairMinRank) {
    var sel = item[eye];
    var uso = item.uso;
    var eyeTier = Q.getEyeMinTier(eyeRx, uso);
    var reqRank = Math.max(eyeTier.rank, pairMinRank || 1);
    var card = block.querySelector('[data-eye="' + eye + '"]');

    card.querySelector('[data-role="rx"]').textContent = formatEyeRxLine(eyeRx);
    var badge = card.querySelector('[data-role="badge"]');
    if (reqRank === 3) {
      badge.className = 'badge lab';
      badge.textContent = eyeTier.rank === 3 ? ('Solo Laboratorio: ' + eyeTier.reason) : 'Laboratorio (por otro ojo)';
    } else if (reqRank === 2) {
      badge.className = 'badge ext';
      badge.textContent = eyeTier.rank === 2 ? 'Rango Extendido o Lab' : 'Rango Extendido o Lab (por otro ojo)';
    } else {
      badge.className = 'badge stock';
      badge.textContent = 'Apto Stock, Rango Ext. y Lab';
    }

    var select = card.querySelector('[data-role="prod"]');
    select.innerHTML = '';
    var defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '— Elegir cristal —';
    select.appendChild(defOpt);

    var stillValid = false;
    state.catalog.forEach(function (p) {
      var chk = Q.checkProductForEye(p, eyeRx, uso, reqRank);
      if (!chk.allowed) return;
      var opt = document.createElement('option');
      opt.value = p.codigo;
      opt.textContent = p.nombre + ' [' + p.tipo + '] — ' + Q.fmtMoney(p.precioMedioPar);
      if (sel.mode === 'catalog' && sel.codigo === p.codigo) stillValid = true;
      select.appendChild(opt);
    });

    var manOpt = document.createElement('option');
    manOpt.value = '__manual__';
    manOpt.textContent = '➕ Carga manual (cristal no listado)';
    select.appendChild(manOpt);

    if (sel.mode === 'manual') {
      select.value = '__manual__';
    } else if (stillValid) {
      select.value = sel.codigo;
    } else {
      sel.codigo = '';
      sel.price = 0;
      select.value = '';
    }

    var isManual = sel.mode === 'manual';
    card.querySelector('[data-role="manual-box"]').hidden = !isManual;
    var tipoSel = card.querySelector('[data-role="man-tipo"]');
    var optStk = tipoSel.querySelector('option[value="Stock"]');
    var optExt = tipoSel.querySelector('option[value="Rango Extendido"]');
    optStk.hidden = reqRank > 1;
    optStk.disabled = reqRank > 1;
    optExt.hidden = reqRank > 2;
    optExt.disabled = reqRank > 2;
    if (reqRank === 3) sel.manual.tipo = 'Laboratorio';
    else if (reqRank === 2 && sel.manual.tipo === 'Stock') sel.manual.tipo = 'Rango Extendido';

    card.querySelector('[data-role="man-nombre"]').value = sel.manual.nombre;
    tipoSel.value = sel.manual.tipo;
    var disenoSel = card.querySelector('[data-role="man-diseno"]');
    if (!sel.manual.diseno) sel.manual.diseno = Q.USO_TO_DISENO[uso] || 'Monofocal';
    disenoSel.value = sel.manual.diseno;
    card.querySelector('[data-role="man-indice"]').value = sel.manual.indice;
    card.querySelector('[data-role="man-trat"]').value = sel.manual.tratamiento;
    card.querySelector('[data-role="man-save"]').checked = Boolean(sel.manual.saveToCatalog);
    card.querySelector('[data-role="price"]').value = sel.price ? String(sel.price) : '';
  }

  function syncQuoteControls() {
    var q = state.quote;
    renderQuoteItemBlocks();
    var rx = collectRx();
    q.items.forEach(function (item, idx) {
      var block = $('#q-items-list').querySelector('.quote-item-block[data-item-idx="' + idx + '"]');
      if (!block) return;
      block.querySelector('[data-role="uso"]').value = item.uso;
      block.querySelector('[data-role="eyes"]').value = item.eyesMode;
      block.querySelector('[data-role="remove"]').hidden = q.items.length <= 1;
      block.querySelector('[data-eye="od"]').hidden = item.eyesMode === 'oi';
      block.querySelector('[data-eye="oi"]').hidden = item.eyesMode === 'od';

      var eff = Q.resolveEffectiveRx(rx, item.uso);
      var tOd = Q.getEyeMinTier(eff.od, item.uso).rank;
      var tOi = Q.getEyeMinTier(eff.oi, item.uso).rank;
      var pairMinRank = item.eyesMode === 'both' ? Math.max(tOd, tOi) : 1;

      syncEyeCard(block, item, 'od', eff.od, item.eyesMode === 'both' ? pairMinRank : tOd);
      syncEyeCard(block, item, 'oi', eff.oi, item.eyesMode === 'both' ? pairMinRank : tOi);
    });

    $('#q-frame-mode').value = q.frameModeSelect;
    $('#q-frame-rim').value = q.frame.rimType;
    $('#q-frame-detail').value = q.frame.detail;
    $('#q-frame-price').value = String(q.frame.price || 0);
    $('#q-discount').value = String(q.discount || 0);
    $('#q-discount-note').value = q.discountNote || '';
    $('#q-deposit').value = String(q.deposit || 0);
    $('#btn-to-close').hidden = !state.budgetIssued;
    syncFrameVisibility();
    refreshQuotePreview();
  }

  function syncFrameVisibility() {
    var fm = $('#q-frame-mode').value;
    state.quote.frameModeSelect = fm;
    if (fm === 'none') {
      state.quote.frame.mode = 'none';
      state.quote.frame.rimType = 'completo';
      state.quote.frame.price = 0;
    } else if (fm === 'propio') {
      state.quote.frame.mode = 'propio';
      state.quote.frame.rimType = $('#q-frame-rim').value || 'completo';
      state.quote.frame.price = 0;
    } else {
      state.quote.frame.mode = 'nuevo';
      state.quote.frame.rimType = fm.replace('nuevo_', '');
    }
    $('#q-frame-rim-wrap').hidden = fm !== 'propio';
    $('#q-frame-detail-wrap').hidden = fm === 'none';
    $('#q-frame-price-wrap').hidden = state.quote.frame.mode !== 'nuevo';
  }

  function onEyeSelectChange(block, itemIdx, eye) {
    var item = state.quote.items[itemIdx];
    var val = block.querySelector('[data-eye="' + eye + '"] [data-role="prod"]').value;
    var sel = item[eye];
    var eff = Q.resolveEffectiveRx(collectRx(), item.uso);
    var tOd = Q.getEyeMinTier(eff.od, item.uso).rank;
    var tOi = Q.getEyeMinTier(eff.oi, item.uso).rank;
    var pairMinRank = item.eyesMode === 'both' ? Math.max(tOd, tOi) : (eye === 'od' ? tOd : tOi);

    if (val === '__manual__') {
      sel.mode = 'manual';
      sel.codigo = '';
      sel.manual.diseno = Q.USO_TO_DISENO[item.uso] || 'Monofocal';
      if (sel.manual.diseno !== 'Monofocal' || pairMinRank === 3) sel.manual.tipo = 'Laboratorio';
      else if (pairMinRank === 2) sel.manual.tipo = 'Rango Extendido';
    } else {
      sel.mode = 'catalog';
      sel.codigo = val;
      var prod = state.catalog.find(function (p) { return p.codigo === val; });
      sel.price = prod ? prod.precioMedioPar : 0;

      // En ambos ojos, sincronizar el rango (Stock / Rango Extendido / Laboratorio) del otro ojo si difiere.
      if (item.eyesMode === 'both' && prod) {
        var otherEye = eye === 'od' ? 'oi' : 'od';
        var otherSel = item[otherEye];
        var otherProd = Q.resolveEyeProduct(otherSel, state.catalog);
        if (!otherProd || otherProd.tipo !== prod.tipo) {
          if (otherSel.mode === 'manual') {
            otherSel.manual.tipo = prod.tipo;
          } else {
            var sameOk = Q.checkProductForEye(prod, eff[otherEye], item.uso, pairMinRank).allowed;
            var match = sameOk ? prod : state.catalog.find(function (p) {
              return p.tipo === prod.tipo && Q.checkProductForEye(p, eff[otherEye], item.uso, pairMinRank).allowed;
            });
            if (match) {
              otherSel.mode = 'catalog';
              otherSel.codigo = match.codigo;
              otherSel.price = match.precioMedioPar;
            }
          }
        }
      }
    }
    syncQuoteControls();
    saveDraft();
  }

  function readManualAndPrice(block, itemIdx, eye) {
    var item = state.quote.items[itemIdx];
    var sel = item[eye];
    var card = block.querySelector('[data-eye="' + eye + '"]');
    sel.manual.nombre = card.querySelector('[data-role="man-nombre"]').value;
    sel.manual.tipo = card.querySelector('[data-role="man-tipo"]').value;
    sel.manual.diseno = card.querySelector('[data-role="man-diseno"]').value;
    sel.manual.indice = card.querySelector('[data-role="man-indice"]').value;
    sel.manual.tratamiento = card.querySelector('[data-role="man-trat"]').value;
    sel.manual.saveToCatalog = card.querySelector('[data-role="man-save"]').checked;
    sel.price = Math.max(0, Number(card.querySelector('[data-role="price"]').value) || 0);
    if (item.eyesMode === 'both' && sel.mode === 'manual') {
      var otherEye = eye === 'od' ? 'oi' : 'od';
      var otherProd = Q.resolveEyeProduct(item[otherEye], state.catalog);
      if (item[otherEye].mode === 'manual' && otherProd && otherProd.tipo !== sel.manual.tipo) {
        item[otherEye].manual.tipo = sel.manual.tipo;
        block.querySelector('[data-eye="' + otherEye + '"] [data-role="man-tipo"]').value = sel.manual.tipo;
      }
    }
    saveDraft();
  }

  function frameSummaryText() {
    var f = state.quote.frame;
    if (f.mode === 'none') return 'Sin armazón (solo cristales)';
    var rimMap = { completo: 'Aro completo', semi: 'Semi al aire (Tanza)', aire: 'Ranurado / Al aire' };
    var tag = f.mode === 'propio' ? 'Propio del cliente' : 'Armazón nuevo';
    var parts = [tag, rimMap[f.rimType] || ''];
    if (f.detail.trim()) parts.push(f.detail.trim());
    return parts.filter(Boolean).join(' · ');
  }

  function describeEyeItem(prod) {
    if (!prod || !prod.nombre) return 'Sin seleccionar';
    return prod.nombre + ' [' + prod.tipo + (prod.indice ? ' · ' + prod.indice : '') + (prod.tratamiento ? ' · ' + prod.tratamiento : '') + ']';
  }

  function optionToQuoteInput(item, q) {
    return {
      uso: item.uso,
      eyesMode: item.eyesMode,
      od: item.od,
      oi: item.oi,
      frame: q.frame,
      discount: q.discount,
      deposit: q.deposit
    };
  }

  function buildQuoteSnapshot() {
    var rx = collectRx();
    var extra = getExtraMap();
    var q = state.quote;
    var multi = q.items.length > 1;
    var allErrors = [];
    var allWarnings = [];
    var payCfg = state.paymentConfig || C.PAYMENT_CONFIG;

    var optionSnapshots = q.items.map(function (item, idx) {
      var singleQ = optionToQuoteInput(item, q);
      var eff = Q.resolveEffectiveRx(rx, item.uso);
      var validation = Q.validateQuote(rx, singleQ, state.catalog);
      var totals = Q.calculateTotals(singleQ, payCfg);
      var prodOd = item.eyesMode !== 'oi' ? Q.resolveEyeProduct(item.od, state.catalog) : null;
      var prodOi = item.eyesMode !== 'od' ? Q.resolveEyeProduct(item.oi, state.catalog) : null;
      var prefix = multi ? ('Opción ' + (idx + 1) + ': ') : '';
      validation.errors.forEach(function (msg) { allErrors.push(prefix + msg); });
      validation.warnings.forEach(function (msg) { allWarnings.push(prefix + msg); });
      return { item: item, eff: eff, validation: validation, totals: totals, prodOd: prodOd, prodOi: prodOi };
    });

    var now = new Date();
    var validUntil = new Date(now.getTime() + (C.QUOTE_VALIDITY_DAYS || 7) * 86400000);
    var fmtDate = function (d) {
      return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    };
    return {
      rx: rx, extra: extra, optionSnapshots: optionSnapshots,
      validation: { errors: allErrors, warnings: allWarnings },
      fechaStr: fmtDate(now), validaStr: fmtDate(validUntil)
    };
  }

  function buildOptionLines(opt, q) {
    var it = opt.item;
    var t = opt.totals;
    var lines = [];
    if (it.eyesMode !== 'oi') lines.push(['½ Par OD: ' + describeEyeItem(opt.prodOd), Q.fmtMoney(t.odPrice), false]);
    if (it.eyesMode !== 'od') lines.push(['½ Par OI: ' + describeEyeItem(opt.prodOi), Q.fmtMoney(t.oiPrice), false]);
    if (q.frame.mode !== 'none') {
      lines.push(['Armazón: ' + frameSummaryText(), q.frame.mode === 'propio' ? '$ 0 (Propio)' : Q.fmtMoney(t.framePrice), false]);
    }
    if (t.discountAmount > 0) {
      lines.push(['Descuento / Obra Social' + (q.discountNote ? ' (' + q.discountNote + ')' : ''), '- ' + Q.fmtMoney(t.discountAmount), false]);
    }
    lines.push(['Total de lista', Q.fmtMoney(t.listTotal), true]);
    if (t.depositAmount > 0) {
      lines.push(['Seña', '- ' + Q.fmtMoney(t.depositAmount), false]);
      lines.push(['Saldo a financiar / abonar', Q.fmtMoney(t.balanceBase), true]);
    }
    return lines;
  }

  function refreshQuotePreview() {
    var snap = buildQuoteSnapshot();
    var alerts = $('#quote-alerts');
    alerts.innerHTML = '';
    snap.validation.errors.forEach(function (msg) {
      var div = document.createElement('div');
      div.className = 'alert err';
      div.textContent = '🔴 ' + msg;
      alerts.appendChild(div);
    });
    snap.validation.warnings.forEach(function (msg) {
      var div = document.createElement('div');
      div.className = 'alert warn';
      div.textContent = '🟡 ' + msg;
      alerts.appendChild(div);
    });

    var q = state.quote;
    var usoLabels = { lejos: 'Lejos', cerca: 'Cerca', multifocal: 'Multifocal', bifocal: 'Bifocal', ocupacional: 'Ocupacional' };
    var eyesLabels = { both: 'Ambos ojos (OD + OI)', od: 'Solo OD', oi: 'Solo OI' };
    var multi = snap.optionSnapshots.length > 1;

    var optionsHtml = snap.optionSnapshots.map(function (opt, idx) {
      var it = opt.item;
      var t = opt.totals;
      var usoLabel = usoLabels[it.uso] || it.uso;

      var itemRows = buildOptionLines(opt, q).map(function (ln) {
        var left = ln[2] ? '<b>' + esc(ln[0]) + '</b>' : esc(ln[0]);
        var right = ln[2] ? '<b>' + esc(ln[1]) + '</b>' : esc(ln[1]);
        return '<tr><td class="left">' + left + '</td><td class="right">' + right + '</td></tr>';
      }).join('');

      var maxPriceNote = (it.eyesMode === 'both' && t.rawOdPrice !== t.rawOiPrice && t.odPrice > 0)
        ? '<p class="qs-note">Graduación más alta define el valor aplicado a ambos cristales (' + esc(Q.fmtMoney(t.odPrice)) + ' c/u).</p>'
        : '';

      var cardRowsHtml = getCardGroups(t).map(function (g) {
        var optText = g.options.map(function (c) { return formatCardOption(c, true); }).join(' · ');
        return '<div class="qs-pay-row"><span>Tarjeta · ' + esc(g.marca) + '</span>' +
          '<span class="qs-pay-sub" style="text-align:right;color:var(--text)">' + esc(optText) + '</span></div>';
      }).join('');

      var cristalinoHtml = t.cristalinoOptions.map(function (p) {
        return '<div class="qs-pay-row"><span>Plan Cristalino ' + p.cuotas + ' cuotas (' + p.surchargePct + '% rec.)</span>' +
          '<span><b>' + esc(Q.fmtMoney(p.cuotaMensual)) + '/mes</b><div class="qs-pay-sub">Total financiado: ' + esc(Q.fmtMoney(p.total)) + '</div></span></div>';
      }).join('');

      var titleHtml = multi
        ? '<div class="qs-option-title"><span>Opción ' + (idx + 1) + ' · Uso: ' + esc(usoLabel) + '</span><span>' + esc(eyesLabels[it.eyesMode] || '') + '</span></div>'
        : '<div class="qs-option-title"><span>Uso: ' + esc(usoLabel) + '</span><span>' + esc(eyesLabels[it.eyesMode] || '') + '</span></div>';

      return '<div class="qs-option-block">' +
        titleHtml +
        '<table class="qs-table"><thead><tr><th class="left">Detalle (cotización por ½ par)</th><th class="right">Importe</th></tr></thead>' +
        '<tbody>' + itemRows + '</tbody></table>' +
        maxPriceNote +
        '<div class="qs-pay"><h4>Medios de pago' + (t.depositAmount > 0 ? ' (sobre saldo)' : '') + '</h4>' +
        '<div class="qs-pay-row highlight"><span>Efectivo (' + t.cashDiscountPct + '% desc.)</span><span>' + esc(Q.fmtMoney(t.cashTotal)) + '</span></div>' +
        '<div class="qs-pay-row"><span>Transferencia bancaria</span><span>' + esc(Q.fmtMoney(t.transferTotal)) + '</span></div>' +
        cardRowsHtml +
        cristalinoHtml +
        '</div></div>';
    }).join('');

    // Sin tabla de graduación para el cliente (regla #3: oculta al imprimir/enviar, guardada en Sheets).
    $('#quote-sheet').innerHTML =
      '<div class="qs-head"><div><div class="qs-title">' + esc(C.OPTICA_NAME || 'Óptica') + '</div>' +
      '<div class="qs-sub">Presupuesto' + (multi ? (' (' + snap.optionSnapshots.length + ' opciones)') : '') + '</div></div>' +
      '<div class="qs-sub">Fecha: ' + esc(snap.fechaStr) + '<br>Válido hasta: ' + esc(snap.validaStr) + '</div></div>' +
      '<div class="qs-meta">' +
      '<div><b>Cliente:</b> ' + esc(snap.extra.nombre || snap.rx.paciente || '—') + '</div>' +
      '<div><b>Tel:</b> ' + esc(snap.extra.telefono || '—') + '</div>' +
      '<div><b>Médico:</b> ' + esc([snap.rx.medico, snap.rx.matricula].filter(Boolean).join(' · ') || '—') + '</div>' +
      '<div><b>Vendedor:</b> ' + esc(snap.extra.vendedor || '—') + '</div>' +
      '</div>' +
      optionsHtml +
      '<p class="qs-note" style="margin:.25rem 0 0">Sujeto a verificación técnica en óptica. Precios válidos hasta el ' + esc(snap.validaStr) + '.</p>';
  }

  function getCardGroups(t) {
    return (t.cardGroups && t.cardGroups.length)
      ? t.cardGroups
      : [{ marca: 'General', options: t.cardOptions || [] }];
  }

  function formatCardOption(c, withTotal) {
    var label = c.plan && !/^\d+\s*cuotas?$/i.test(c.plan)
      ? c.plan
      : (c.cuotas === 1 ? '1×' : c.cuotas + '×');
    if (c.cuotas === 1) return label + ' ' + Q.fmtMoney(c.total);
    return label + ' ' + Q.fmtMoney(c.cuotaMensual) + (withTotal ? ' (Tot ' + Q.fmtMoney(c.total) + ')' : '');
  }

  function generateQuotePngBlob() {
    var snap = buildQuoteSnapshot();
    var q = state.quote;
    var W = 900;
    var pad = 42;
    var usoLabels = { lejos: 'Lejos', cerca: 'Cerca', multifocal: 'Multifocal', bifocal: 'Bifocal', ocupacional: 'Ocupacional' };
    var multi = snap.optionSnapshots.length > 1;

    var blocks = snap.optionSnapshots.map(function (opt, idx) {
      var t = opt.totals;
      var lines = buildOptionLines(opt, q);
      var cardGroups = getCardGroups(t);
      var headerH = multi ? 30 : 0;
      var linesH = lines.length * 36;
      var payH = 98 + cardGroups.length * 26 + t.cristalinoOptions.length * 32;
      var totalH = headerH + linesH + 6 + payH + 26;
      return {
        idx: idx, opt: opt, t: t, lines: lines, cardGroups: cardGroups,
        headerH: headerH, payH: payH, totalH: totalH,
        usoLabel: usoLabels[opt.item.uso] || opt.item.uso
      };
    });

    var startY = 188;
    var bodyH = blocks.reduce(function (acc, b) { return acc + b.totalH; }, 0);
    var H = startY + bodyH + 26;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#0f766e';
    ctx.fillRect(0, 0, W, 92);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(C.OPTICA_NAME || 'Óptica Cristalino', pad, 44);
    ctx.font = '16px system-ui, sans-serif';
    var subHdr = multi
      ? ('Presupuesto Óptico · ' + blocks.length + ' opciones independientes')
      : ('Presupuesto Óptico · Uso: ' + blocks[0].usoLabel);
    ctx.fillText(subHdr, pad, 72);
    ctx.textAlign = 'right';
    ctx.fillText('Fecha: ' + snap.fechaStr, W - pad, 42);
    ctx.fillText('Válido hasta: ' + snap.validaStr, W - pad, 68);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillText('Cliente: ' + (snap.extra.nombre || snap.rx.paciente || '—'), pad, 126);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Vendedor: ' + (snap.extra.vendedor || '—') + '   ·   Médico: ' + ([snap.rx.medico, snap.rx.matricula].filter(Boolean).join(' ') || '—'), pad, 152);

    var y = startY;
    blocks.forEach(function (blk) {
      var t = blk.t;
      if (blk.headerH > 0) {
        ctx.fillStyle = '#ccfbf1';
        ctx.fillRect(pad, y - 16, W - pad * 2, 24);
        ctx.fillStyle = '#115e59';
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('OPCIÓN ' + (blk.idx + 1) + '  ·  USO: ' + blk.usoLabel.toUpperCase(), pad + 10, y + 1);
        y += blk.headerH;
      }

      blk.lines.forEach(function (ln) {
        ctx.font = ln[2] ? 'bold 17px system-ui, sans-serif' : '15px system-ui, sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'left';
        var label = ln[0].length > 62 ? ln[0].slice(0, 61) + '…' : ln[0];
        ctx.fillText(label, pad, y);
        ctx.textAlign = 'right';
        ctx.fillText(ln[1], W - pad, y);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath(); ctx.moveTo(pad, y + 11); ctx.lineTo(W - pad, y + 11); ctx.stroke();
        y += 36;
      });

      y += 6;
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(pad, y, W - pad * 2, blk.payH);
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(pad, y, W - pad * 2, blk.payH);

      var py = y + 26;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#115e59';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText('MEDIOS DE PAGO' + (t.depositAmount > 0 ? ' (SOBRE SALDO)' : ''), pad + 16, py);
      py += 28;
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillText('Efectivo (' + t.cashDiscountPct + '% descuento):', pad + 16, py);
      ctx.textAlign = 'right';
      ctx.fillText(Q.fmtMoney(t.cashTotal), W - pad - 16, py);
      py += 26;
      ctx.fillStyle = '#0f172a';
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Transferencia bancaria:', pad + 16, py);
      ctx.textAlign = 'right';
      ctx.fillText(Q.fmtMoney(t.transferTotal), W - pad - 16, py);
      blk.cardGroups.forEach(function (g) {
        py += 26;
        ctx.textAlign = 'left';
        var cardsStr = g.options.map(function (c) { return formatCardOption(c, false); }).join('  ·  ');
        var cardLine = 'Tarjeta ' + g.marca + ': ' + cardsStr;
        if (cardLine.length > 88) cardLine = cardLine.slice(0, 87) + '…';
        ctx.fillText(cardLine, pad + 16, py);
      });
      t.cristalinoOptions.forEach(function (p) {
        py += 32;
        ctx.textAlign = 'left';
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.fillText('Plan Cristalino ' + p.cuotas + ' cuotas (' + p.surchargePct + '% rec.):', pad + 16, py);
        ctx.textAlign = 'right';
        ctx.fillText(Q.fmtMoney(p.cuotaMensual) + '/mes  (Total: ' + Q.fmtMoney(p.total) + ')', W - pad - 16, py);
      });

      y += blk.payH + 26;
    });

    ctx.textAlign = 'left';
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Presupuesto válido hasta ' + snap.validaStr + '. Sujeto a verificación técnica en óptica.', pad, H - 16);

    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
  }

  async function shareOrDownloadQuoteImage() {
    var blob = await generateQuotePngBlob();
    if (!blob) return toast('No se pudo generar la imagen.');
    var extra = getExtraMap();
    var cleanName = (extra.nombre || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cliente';
    var fileName = 'Presupuesto_' + cleanName + '.png';
    var file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Presupuesto ' + (C.OPTICA_NAME || ''), text: 'Presupuesto óptico de ' + (extra.nombre || 'cliente') });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Imagen descargada (' + fileName + '). Adjuntala en WhatsApp.');
  }

  function buildBudgetSavePayload() {
    var snap = buildQuoteSnapshot();
    var extraFields = collectExtraFields();
    var nameField = extraFields.find(function (f) { return f.key === C.PHOTO_NAME_FIELD; });
    var q = state.quote;

    var newCatalogItems = [];
    var seenManual = {};
    q.items.forEach(function (it) {
      ['od', 'oi'].forEach(function (eye) {
        if ((eye === 'od' && it.eyesMode === 'oi') || (eye === 'oi' && it.eyesMode === 'od')) return;
        var sel = it[eye];
        if (sel.mode === 'manual' && sel.manual.saveToCatalog) {
          var prod = Q.resolveEyeProduct(sel, state.catalog);
          var dedupKey = [prod.nombre, prod.tipo, prod.diseno, prod.indice, prod.tratamiento, prod.precioMedioPar].join('|');
          if (!seenManual[dedupKey]) {
            seenManual[dedupKey] = true;
            newCatalogItems.push({
              nombre: prod.nombre,
              tipo: prod.tipo,
              diseno: prod.diseno,
              indice: prod.indice,
              tratamiento: prod.tratamiento,
              precioMedioPar: prod.precioMedioPar
            });
          }
        }
      });
    });

    var quoteItems = snap.optionSnapshots.map(function (opt, idx) {
      var it = opt.item;
      var t = opt.totals;
      var cristalinoTxt = t.cristalinoOptions.map(function (p) {
        return p.cuotas + '×' + Q.fmtMoney(p.cuotaMensual) + ' (' + Q.fmtMoney(p.total) + ')';
      }).join(' | ');
      return {
        opcion: idx + 1,
        uso: it.uso,
        eyesMode: it.eyesMode,
        odNombre: it.eyesMode === 'oi' ? '' : (opt.prodOd ? opt.prodOd.nombre : ''),
        odTipo: it.eyesMode === 'oi' ? '' : (opt.prodOd ? opt.prodOd.tipo : ''),
        odPrecio: it.eyesMode === 'oi' ? '' : String(t.odPrice),
        oiNombre: it.eyesMode === 'od' ? '' : (opt.prodOi ? opt.prodOi.nombre : ''),
        oiTipo: it.eyesMode === 'od' ? '' : (opt.prodOi ? opt.prodOi.tipo : ''),
        oiPrecio: it.eyesMode === 'od' ? '' : String(t.oiPrice),
        armazon: q.frame.mode === 'none' ? '' : frameSummaryText(),
        armazonPrecio: String(t.framePrice),
        descuento: t.discountAmount ? (String(t.discountAmount) + (q.discountNote ? ' (' + q.discountNote + ')' : '')) : '0',
        sena: String(t.depositAmount),
        totalLista: String(t.listTotal),
        totalEfectivo: String(t.cashTotal),
        planCristalino: cristalinoTxt
      };
    });

    return {
      newCatalogItems: newCatalogItems,
      payload: {
        uuid: state.uuid,
        stage: 'presupuestado',
        image: state.photoUploaded ? '' : state.image,
        photoName: nameField ? nameField.value : '',
        rx: snap.rx,
        extras: state.extras.filter(function (x) { return x.decision === 'keep' && x.texto.trim(); })
          .map(function (x) { return x.texto.trim(); }),
        extraFields: extraFields,
        isRx: !(state.ocr.rx && state.ocr.rx.es_receta_optica === false),
        corrected: wasCorrected(snap.rx),
        newCatalogItems: newCatalogItems,
        quoteItems: quoteItems,
        quoteSummary: quoteItems[0],
        timings: buildTimingsPayload()
      }
    };
  }

  async function saveBudgetAndThen(mode) {
    setError('#quote-error', '');
    var snap = buildQuoteSnapshot();
    if (snap.validation.errors.length) {
      setError('#quote-error', snap.validation.errors[0]);
      $('#quote-alerts').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (snap.validation.warnings.length) {
      var ok = confirm('Advertencias técnicas:\n• ' + snap.validation.warnings.join('\n• ') + '\n\n¿Continuar igualmente?');
      if (!ok) return;
    }

    if (state.inFlightSave) await state.inFlightSave;
    markStep('paso4Sec');
    var built = buildBudgetSavePayload();

    $('#btn-print-quote').disabled = true;
    $('#btn-share-quote').disabled = true;
    loading(true, 'Guardando presupuesto en Drive y Sheets…');
    var res = null;
    try {
      res = await withAuth(function (tok) { return Api.save(Object.assign({ idToken: tok }, built.payload)); });
      state.photoUploaded = true;
      state.budgetIssued = true;
      state.lastResult = res;
      if (built.newCatalogItems.length) state.catalogLoaded = false;
      $('#btn-to-close').hidden = false;
      saveDraft();
    } catch (e) {
      setError('#quote-error', e.message + ' (reintentá sin riesgo de duplicar fila)');
      return;
    } finally {
      loading(false);
      $('#btn-print-quote').disabled = false;
      $('#btn-share-quote').disabled = false;
    }

    if (mode === 'print') {
      window.print();
    } else {
      await shareOrDownloadQuoteImage();
    }
    showDone(res);
  }

  // ---------- Cierre de venta (Paso 5) ----------

  function syncCloseFields() {
    var soldVal = ($('#close-form').elements.sold && $('#close-form').elements.sold.value) || '';
    var isYes = soldVal === 'si';
    var isNo = soldVal === 'no';
    $('#close-yes-fields').hidden = !isYes;
    $('#close-no-fields').hidden = !isNo;
    ['#c-ot', '#c-monto', '#c-tipo-lente'].forEach(function (id) {
      var el = $(id);
      el.disabled = !isYes;
      el.required = isYes;
      if (!isYes) el.value = '';
    });
    var mot = $('#c-motivo');
    mot.disabled = !isNo;
    mot.required = isNo;
    if (!isNo) mot.value = '';
  }

  function showDone(res) {
    res = res || {};
    var parts = [];
    if (Array.isArray(res.filas) && res.filas.length > 1) parts.push('Filas ' + res.filas.join(', ') + ' del Sheet.');
    else if (res.fila) parts.push('Fila ' + res.fila + ' del Sheet.');
    if (res.fotoNombre) parts.push('Foto: ' + res.fotoNombre);
    if (res.demo) parts.push('(Demo: no se guardó nada)');
    $('#done-detail').textContent = parts.join(' ');
    var link = $('#done-link');
    link.hidden = !res.fotoUrl;
    if (res.fotoUrl) link.href = res.fotoUrl;
    $('#close-form').reset();
    syncCloseFields();
    setError('#close-error', '');
    go('done');
  }

  async function submitClose(ev) {
    ev.preventDefault();
    var form = $('#close-form');
    ['#c-ot', '#c-tipo-lente', '#c-motivo'].forEach(function (id) {
      var el = $(id);
      if (el && !el.disabled) el.value = el.value.trim();
    });
    if (!form.reportValidity()) return;
    setError('#close-error', '');

    if (state.inFlightSave) await state.inFlightSave;
    markStep('cierreSec');
    var sold = form.elements.sold.value === 'si';
    var extraFields = collectExtraFields();
    var nameField = extraFields.find(function (f) { return f.key === C.PHOTO_NAME_FIELD; });
    var payload = {
      uuid: state.uuid,
      stage: 'cerrado',
      image: state.photoUploaded ? '' : state.image,
      photoName: nameField ? nameField.value : '',
      closure: sold ? {
        sold: true,
        ot: $('#c-ot').value.trim(),
        monto: Number($('#c-monto').value) || 0,
        tipoLente: $('#c-tipo-lente').value.trim(),
        motivo: ''
      } : {
        sold: false,
        ot: '',
        monto: '',
        tipoLente: '',
        motivo: $('#c-motivo').value.trim()
      },
      timings: buildTimingsPayload()
    };

    $('#btn-close-submit').disabled = true;
    loading(true, 'Registrando cierre de venta…');
    try {
      await withAuth(function (tok) { return Api.save(Object.assign({ idToken: tok }, payload)); });
      clearDraft();
      resetFlow();
      go('capture');
      toast('Cierre registrado correctamente.');
    } catch (e) {
      setError('#close-error', e.message + ' (reintentá)');
    } finally {
      loading(false);
      $('#btn-close-submit').disabled = false;
    }
  }

  // ---------- Abandonar Presupuesto ----------

  function openAbandonModal() {
    $('#abandon-reason').value = '';
    setError('#abandon-error', '');
    $('#abandon-modal').hidden = false;
    $('#abandon-reason').focus();
  }

  async function submitAbandon(ev) {
    ev.preventDefault();
    var reasonEl = $('#abandon-reason');
    reasonEl.value = reasonEl.value.trim();
    if (!$('#abandon-form').reportValidity()) return;
    setError('#abandon-error', '');

    if (state.inFlightSave) await state.inFlightSave;
    markStep(stepKeyForScreen(state.screen));

    var rxValues = collectRx();
    var extraFields = collectExtraFields();
    var nameField = extraFields.find(function (f) { return f.key === C.PHOTO_NAME_FIELD; });
    var photoName = (nameField && nameField.value) || (rxValues.paciente || '').trim() || 'Pendiente';

    var payload = {
      uuid: state.uuid,
      stage: 'abandonado',
      image: state.photoUploaded ? '' : state.image,
      photoName: photoName,
      rx: rxValues,
      extras: state.extras.filter(function (x) { return x.decision === 'keep' && x.texto.trim(); })
        .map(function (x) { return x.texto.trim(); }),
      extraFields: extraFields,
      isRx: !(state.ocr && state.ocr.rx && state.ocr.rx.es_receta_optica === false),
      corrected: state.ocr ? wasCorrected(rxValues) : false,
      closure: { motivo: reasonEl.value },
      timings: buildTimingsPayload()
    };

    $('#btn-abandon-confirm').disabled = true;
    loading(true, 'Guardando presupuesto abandonado…');
    try {
      await withAuth(function (tok) { return Api.save(Object.assign({ idToken: tok }, payload)); });
      $('#abandon-modal').hidden = true;
      clearDraft();
      resetFlow();
      go('capture');
      toast('Presupuesto guardado como ABANDONADO.');
    } catch (e) {
      setError('#abandon-error', e.message + ' (reintentá)');
    } finally {
      loading(false);
      $('#btn-abandon-confirm').disabled = false;
    }
  }

  function resetFlow() {
    clearDraft();
    state.image = null;
    state.ocr = null;
    state.extras = [];
    state.original = {};
    state.uuid = null;
    state.prefilledName = '';
    state.quoteInitialized = false;
    state.budgetIssued = false;
    state.photoUploaded = false;
    state.lastResult = null;
    state.quote = defaultQuoteState();
    state.timers = defaultTimers();
    $('#extra-form').reset();
    $('#close-form').reset();
    syncConditionalFields();
    syncCloseFields();
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
      if (!restoreDraftIfAny()) go('capture');
    });
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-abandon').addEventListener('click', openAbandonModal);
    $('#btn-abandon-cancel').addEventListener('click', function () { $('#abandon-modal').hidden = true; });
    $('#abandon-form').addEventListener('submit', submitAbandon);

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
    $('#extra-form').addEventListener('submit', toQuote);
    $('#btn-back-extra').addEventListener('click', function () { go('extra'); });
    $('#btn-to-close').addEventListener('click', function () { showDone(state.lastResult || { fila: '—' }); });
    $('#btn-print-quote').addEventListener('click', function () { saveBudgetAndThen('print'); });
    $('#btn-share-quote').addEventListener('click', function () { saveBudgetAndThen('whatsapp'); });
    $('#btn-done-print').addEventListener('click', function () { window.print(); });
    $('#btn-done-share').addEventListener('click', shareOrDownloadQuoteImage);

    $('#close-form').addEventListener('change', function (e) {
      if (e.target && e.target.name === 'sold') syncCloseFields();
    });
    $('#close-form').addEventListener('submit', submitClose);

    $('#btn-add-quote-item').addEventListener('click', function () {
      var rx = collectRx();
      state.quote.items.push(defaultQuoteItem(Q.inferDefaultUso(rx)));
      syncQuoteControls();
      saveDraft();
      var blocks = $('#q-items-list').querySelectorAll('.quote-item-block');
      if (blocks.length) blocks[blocks.length - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    $('#q-frame-mode').addEventListener('change', function () { syncFrameVisibility(); refreshQuotePreview(); saveDraft(); });
    $('#q-frame-rim').addEventListener('change', function () { syncFrameVisibility(); refreshQuotePreview(); saveDraft(); });
    $('#q-frame-detail').addEventListener('input', function () { state.quote.frame.detail = $('#q-frame-detail').value; refreshQuotePreview(); saveDraft(); });
    $('#q-frame-price').addEventListener('input', function () { state.quote.frame.price = Math.max(0, Number($('#q-frame-price').value) || 0); refreshQuotePreview(); saveDraft(); });
    $('#q-discount').addEventListener('input', function () { state.quote.discount = Math.max(0, Number($('#q-discount').value) || 0); refreshQuotePreview(); saveDraft(); });
    $('#q-discount-note').addEventListener('input', function () { state.quote.discountNote = $('#q-discount-note').value; refreshQuotePreview(); saveDraft(); });
    $('#q-deposit').addEventListener('input', function () { state.quote.deposit = Math.max(0, Number($('#q-deposit').value) || 0); refreshQuotePreview(); saveDraft(); });

    window.addEventListener('beforeunload', function (e) {
      if (state.screen !== 'login' && (state.image || ['review', 'extra', 'quote', 'done'].indexOf(state.screen) >= 0)) {
        saveDraft();
        e.preventDefault();
        e.returnValue = '';
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $('#zoom').hidden = true;
        $('#abandon-modal').hidden = true;
      }
    });
  }

  function registerSw() {
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW:', e); });
    }
  }

  bind();
  renderExtraForm();
  syncCloseFields();
  go('login');
  initAuth();
  registerSw();
})();
