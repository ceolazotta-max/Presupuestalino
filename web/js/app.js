/**
 * app.js — Flujo: login → foto → OCR → revisión → datos → presupuesto → guardado.
 */
(function () {
  'use strict';
  var C = window.APP_CONFIG;
  var Q = window.Quote;
  var $ = function (sel) { return document.querySelector(sel); };

  function defaultQuoteState() {
    return {
      uso: 'lejos',
      eyesMode: 'both',
      od: { mode: 'catalog', codigo: '', price: 0, manual: { nombre: '', tipo: 'Stock', diseno: 'Monofocal', indice: '1.50', tratamiento: '', saveToCatalog: false } },
      oi: { mode: 'catalog', codigo: '', price: 0, manual: { nombre: '', tipo: 'Stock', diseno: 'Monofocal', indice: '1.50', tratamiento: '', saveToCatalog: false } },
      frameModeSelect: 'none',
      frame: { mode: 'none', rimType: 'completo', detail: '', price: 0 },
      discount: 0,
      discountNote: '',
      deposit: 0
    };
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
    catalogLoaded: false,
    quoteInitialized: false,
    quote: defaultQuoteState(),
    screen: 'login',
    reauthResolve: null
  };

  // ---------- Navegación ----------

  var ORDER = ['capture', 'review', 'extra', 'quote', 'done'];

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
    loading(true, 'Cargando catálogo de cristales…');
    try {
      var res = await withAuth(function (t) { return Api.catalog(t); });
      if (res && Array.isArray(res.items) && res.items.length) {
        state.catalog = res.items;
        state.catalogLoaded = true;
      }
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
    await ensureCatalog();
    var rx = collectRx();
    if (!state.quoteInitialized) {
      state.quote = defaultQuoteState();
      state.quote.uso = Q.inferDefaultUso(rx);
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

  function syncEyeCard(eye, eyeRx) {
    var sel = state.quote[eye];
    var uso = state.quote.uso;
    var stockCheck = Q.canEyeUseStock(eyeRx, uso);

    $('#q-rx-' + eye).textContent = formatEyeRxLine(eyeRx);
    var badge = $('#q-badge-' + eye);
    badge.className = 'badge ' + (stockCheck.ok ? 'stock' : 'lab');
    badge.textContent = stockCheck.ok ? 'Apto Stock y Lab' : 'Solo Laboratorio: ' + stockCheck.reason;

    var select = $('#q-prod-' + eye);
    select.innerHTML = '';
    var defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '— Elegir cristal —';
    select.appendChild(defOpt);

    var stillValid = false;
    state.catalog.forEach(function (p) {
      var chk = Q.checkProductForEye(p, eyeRx, uso);
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
    $('#q-manual-' + eye).hidden = !isManual;
    var tipoSel = $('#q-man-tipo-' + eye);
    var stockOpt = tipoSel.querySelector('option[value="Stock"]');
    stockOpt.hidden = !stockCheck.ok;
    stockOpt.disabled = !stockCheck.ok;
    if (!stockCheck.ok && sel.manual.tipo === 'Stock') sel.manual.tipo = 'Laboratorio';

    $('#q-man-nombre-' + eye).value = sel.manual.nombre;
    tipoSel.value = sel.manual.tipo;
    var disenoSel = $('#q-man-diseno-' + eye);
    if (!sel.manual.diseno) sel.manual.diseno = Q.USO_TO_DISENO[uso] || 'Monofocal';
    disenoSel.value = sel.manual.diseno;
    $('#q-man-indice-' + eye).value = sel.manual.indice;
    $('#q-man-trat-' + eye).value = sel.manual.tratamiento;
    $('#q-man-save-' + eye).checked = Boolean(sel.manual.saveToCatalog);
    $('#q-price-' + eye).value = sel.price ? String(sel.price) : '';
  }

  function syncQuoteControls() {
    var q = state.quote;
    $('#q-uso').value = q.uso;
    $('#q-eyes').value = q.eyesMode;
    $('#q-card-od').hidden = q.eyesMode === 'oi';
    $('#q-card-oi').hidden = q.eyesMode === 'od';

    var eff = Q.resolveEffectiveRx(collectRx(), q.uso);
    syncEyeCard('od', eff.od);
    syncEyeCard('oi', eff.oi);

    $('#q-frame-mode').value = q.frameModeSelect;
    $('#q-frame-rim').value = q.frame.rimType;
    $('#q-frame-detail').value = q.frame.detail;
    $('#q-frame-price').value = String(q.frame.price || 0);
    $('#q-discount').value = String(q.discount || 0);
    $('#q-discount-note').value = q.discountNote || '';
    $('#q-deposit').value = String(q.deposit || 0);
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

  function onEyeSelectChange(eye) {
    var val = $('#q-prod-' + eye).value;
    var sel = state.quote[eye];
    if (val === '__manual__') {
      sel.mode = 'manual';
      sel.codigo = '';
      sel.manual.diseno = Q.USO_TO_DISENO[state.quote.uso] || 'Monofocal';
      if (sel.manual.diseno !== 'Monofocal') sel.manual.tipo = 'Laboratorio';
    } else {
      sel.mode = 'catalog';
      sel.codigo = val;
      var prod = state.catalog.find(function (p) { return p.codigo === val; });
      sel.price = prod ? prod.precioMedioPar : 0;
      $('#q-price-' + eye).value = sel.price ? String(sel.price) : '';
    }
    var eff = Q.resolveEffectiveRx(collectRx(), state.quote.uso);
    syncEyeCard(eye, eff[eye]);
    refreshQuotePreview();
  }

  function readManualAndPrice(eye) {
    var sel = state.quote[eye];
    sel.manual.nombre = $('#q-man-nombre-' + eye).value;
    sel.manual.tipo = $('#q-man-tipo-' + eye).value;
    sel.manual.diseno = $('#q-man-diseno-' + eye).value;
    sel.manual.indice = $('#q-man-indice-' + eye).value;
    sel.manual.tratamiento = $('#q-man-trat-' + eye).value;
    sel.manual.saveToCatalog = $('#q-man-save-' + eye).checked;
    sel.price = Math.max(0, Number($('#q-price-' + eye).value) || 0);
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

  function describeEyeItem(eye, prod) {
    if (!prod || !prod.nombre) return 'Sin seleccionar';
    var parts = [prod.nombre, '[' + prod.tipo + (prod.indice ? ' · ' + prod.indice : '') + (prod.tratamiento ? ' · ' + prod.tratamiento : '') + ']'];
    return parts.join(' ');
  }

  function buildQuoteSnapshot() {
    var rx = collectRx();
    var extra = getExtraMap();
    var q = state.quote;
    var eff = Q.resolveEffectiveRx(rx, q.uso);
    var validation = Q.validateQuote(rx, q, state.catalog);
    var totals = Q.calculateTotals(q, C.PAYMENT_CONFIG);
    var prodOd = q.eyesMode !== 'oi' ? Q.resolveEyeProduct(q.od, state.catalog) : null;
    var prodOi = q.eyesMode !== 'od' ? Q.resolveEyeProduct(q.oi, state.catalog) : null;

    var now = new Date();
    var validUntil = new Date(now.getTime() + (C.QUOTE_VALIDITY_DAYS || 7) * 86400000);
    var fmtDate = function (d) {
      return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    };
    return {
      rx: rx, extra: extra, eff: eff, validation: validation, totals: totals,
      prodOd: prodOd, prodOi: prodOi,
      fechaStr: fmtDate(now), validaStr: fmtDate(validUntil)
    };
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
    var t = snap.totals;
    var usoLabels = { lejos: 'Lejos', cerca: 'Cerca', multifocal: 'Multifocal', bifocal: 'Bifocal', ocupacional: 'Ocupacional' };
    var usoLabel = usoLabels[q.uso] || q.uso;
    var hasTransposed = (q.eyesMode !== 'oi' && snap.eff.od.transposed) || (q.eyesMode !== 'od' && snap.eff.oi.transposed);

    var rxRows = ['od', 'oi'].map(function (eye) {
      var er = snap.eff[eye];
      var mark = (eye === 'od' && q.eyesMode === 'oi') || (eye === 'oi' && q.eyesMode === 'od') ? ' (No cotiz.)' : '';
      return '<tr><th>' + eye.toUpperCase() + mark + '</th>' +
        '<td>' + esc(Q.fmtDiopter(er.esf_t)) + '</td>' +
        '<td>' + esc(Q.fmtDiopter(er.cil_t)) + '</td>' +
        '<td>' + esc(Q.fmtAxis(er.eje_t)) + '</td>' +
        '<td>' + esc(er.add ? Q.fmtDiopter(er.add) : '—') + '</td>' +
        '<td>' + esc(snap.eff.dip || '—') + '</td>' +
        '<td>' + esc(snap.eff.prisma || '—') + '</td></tr>';
    }).join('');

    var itemRows = '';
    if (q.eyesMode !== 'oi') {
      itemRows += '<tr><td class="left"><b>½ Par OD:</b> ' + esc(describeEyeItem('od', snap.prodOd)) + '</td><td class="right">' + esc(Q.fmtMoney(t.odPrice)) + '</td></tr>';
    }
    if (q.eyesMode !== 'od') {
      itemRows += '<tr><td class="left"><b>½ Par OI:</b> ' + esc(describeEyeItem('oi', snap.prodOi)) + '</td><td class="right">' + esc(Q.fmtMoney(t.oiPrice)) + '</td></tr>';
    }
    if (q.frame.mode !== 'none') {
      itemRows += '<tr><td class="left"><b>Armazón:</b> ' + esc(frameSummaryText()) + '</td><td class="right">' +
        esc(q.frame.mode === 'propio' ? '$ 0 (Propio)' : Q.fmtMoney(t.framePrice)) + '</td></tr>';
    }
    if (t.discountAmount > 0) {
      var dNote = q.discountNote ? ' (' + q.discountNote + ')' : '';
      itemRows += '<tr><td class="left">Descuento / Obra Social' + esc(dNote) + '</td><td class="right">- ' + esc(Q.fmtMoney(t.discountAmount)) + '</td></tr>';
    }
    itemRows += '<tr><td class="left"><b>Total de lista</b></td><td class="right"><b>' + esc(Q.fmtMoney(t.listTotal)) + '</b></td></tr>';
    if (t.depositAmount > 0) {
      itemRows += '<tr><td class="left">Seña</td><td class="right">- ' + esc(Q.fmtMoney(t.depositAmount)) + '</td></tr>';
      itemRows += '<tr><td class="left"><b>Saldo a financiar / abonar</b></td><td class="right"><b>' + esc(Q.fmtMoney(t.balanceBase)) + '</b></td></tr>';
    }

    var cardText = t.cardOptions.map(function (c) {
      return c.cuotas === 1 ? '1× ' + Q.fmtMoney(c.total) : c.cuotas + '× ' + Q.fmtMoney(c.cuotaMensual) + ' (Tot ' + Q.fmtMoney(c.total) + ')';
    }).join(' · ');

    var cristalinoHtml = t.cristalinoOptions.map(function (p) {
      return '<div class="qs-pay-row"><span>Plan Cristalino ' + p.cuotas + ' cuotas (' + p.surchargePct + '% rec.)</span>' +
        '<span><b>' + esc(Q.fmtMoney(p.cuotaMensual)) + '/mes</b><div class="qs-pay-sub">Total financiado: ' + esc(Q.fmtMoney(p.total)) + '</div></span></div>';
    }).join('');

    $('#quote-sheet').innerHTML =
      '<div class="qs-head"><div><div class="qs-title">' + esc(C.OPTICA_NAME || 'Óptica') + '</div>' +
      '<div class="qs-sub">Ficha Técnica y Presupuesto · Uso: ' + esc(usoLabel) + '</div></div>' +
      '<div class="qs-sub">Fecha: ' + esc(snap.fechaStr) + '<br>Válido hasta: ' + esc(snap.validaStr) + '</div></div>' +
      '<div class="qs-meta">' +
      '<div><b>Cliente:</b> ' + esc(snap.extra.nombre || snap.rx.paciente || '—') + '</div>' +
      '<div><b>Tel:</b> ' + esc(snap.extra.telefono || '—') + '</div>' +
      '<div><b>Médico:</b> ' + esc([snap.rx.medico, snap.rx.matricula].filter(Boolean).join(' · ') || '—') + '</div>' +
      '<div><b>Vendedor:</b> ' + esc(snap.extra.vendedor || '—') + '</div>' +
      '</div>' +
      '<table class="qs-table"><thead><tr><th>Ojo</th><th>Esf</th><th>Cil</th><th>Eje</th><th>Add</th><th>DIP</th><th>Prisma</th></tr></thead>' +
      '<tbody>' + rxRows + '</tbody></table>' +
      (hasTransposed ? '<p class="qs-note">Graduación expresada en cilindro negativo estándar de laboratorio.</p>' : '') +
      '<table class="qs-table"><thead><tr><th class="left">Detalle (cotización por ½ par)</th><th class="right">Importe</th></tr></thead>' +
      '<tbody>' + itemRows + '</tbody></table>' +
      '<div class="qs-pay"><h4>Medios de pago' + (t.depositAmount > 0 ? ' (sobre saldo)' : '') + '</h4>' +
      '<div class="qs-pay-row highlight"><span>Efectivo (' + t.cashDiscountPct + '% desc.)</span><span>' + esc(Q.fmtMoney(t.cashTotal)) + '</span></div>' +
      '<div class="qs-pay-row"><span>Transferencia bancaria</span><span>' + esc(Q.fmtMoney(t.transferTotal)) + '</span></div>' +
      '<div class="qs-pay-row"><span>Tarjeta</span><span class="qs-pay-sub" style="text-align:right;color:var(--text)">' + esc(cardText) + '</span></div>' +
      cristalinoHtml +
      '</div>' +
      '<p class="qs-note" style="margin:.65rem 0 0">Sujeto a verificación técnica en óptica. Precios válidos hasta el ' + esc(snap.validaStr) + '.</p>';
  }

  function generateQuotePngBlob() {
    var snap = buildQuoteSnapshot();
    var q = state.quote;
    var t = snap.totals;
    var W = 900;
    var pad = 42;
    var usoLabels = { lejos: 'Lejos', cerca: 'Cerca', multifocal: 'Multifocal', bifocal: 'Bifocal', ocupacional: 'Ocupacional' };

    var lines = [];
    if (q.eyesMode !== 'oi') lines.push(['½ Par OD: ' + describeEyeItem('od', snap.prodOd), Q.fmtMoney(t.odPrice)]);
    if (q.eyesMode !== 'od') lines.push(['½ Par OI: ' + describeEyeItem('oi', snap.prodOi), Q.fmtMoney(t.oiPrice)]);
    if (q.frame.mode !== 'none') lines.push(['Armazón: ' + frameSummaryText(), q.frame.mode === 'propio' ? '$ 0 (Propio)' : Q.fmtMoney(t.framePrice)]);
    if (t.discountAmount > 0) lines.push(['Descuento / OS' + (q.discountNote ? ' (' + q.discountNote + ')' : ''), '- ' + Q.fmtMoney(t.discountAmount)]);
    lines.push(['Total de lista', Q.fmtMoney(t.listTotal), true]);
    if (t.depositAmount > 0) {
      lines.push(['Seña', '- ' + Q.fmtMoney(t.depositAmount)]);
      lines.push(['Saldo a abonar', Q.fmtMoney(t.balanceBase), true]);
    }

    var H = 560 + lines.length * 38 + t.cristalinoOptions.length * 42;
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
    ctx.fillText('Presupuesto Óptico · Uso: ' + (usoLabels[q.uso] || q.uso), pad, 72);
    ctx.textAlign = 'right';
    ctx.fillText('Fecha: ' + snap.fechaStr, W - pad, 42);
    ctx.fillText('Válido hasta: ' + snap.validaStr, W - pad, 68);
    ctx.textAlign = 'left';

    var y = 128;
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillText('Cliente: ' + (snap.extra.nombre || snap.rx.paciente || '—'), pad, y);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Vendedor: ' + (snap.extra.vendedor || '—') + '   ·   Médico: ' + ([snap.rx.medico, snap.rx.matricula].filter(Boolean).join(' ') || '—'), pad, y + 26);

    y += 52;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(pad, y, W - pad * 2, 102);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(pad, y, W - pad * 2, 102);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 15px monospace';
    ctx.fillText('OJO   ESF      CIL      EJE    ADD      DIP   PRISMA', pad + 16, y + 28);
    ctx.font = '16px monospace';
    ['od', 'oi'].forEach(function (eye, idx) {
      var er = snap.eff[eye];
      var rowTxt = eye.toUpperCase().padEnd(6, ' ') +
        Q.fmtDiopter(er.esf_t).padEnd(9, ' ') +
        Q.fmtDiopter(er.cil_t).padEnd(9, ' ') +
        Q.fmtAxis(er.eje_t).padEnd(7, ' ') +
        (er.add ? Q.fmtDiopter(er.add) : '—').padEnd(9, ' ') +
        (snap.eff.dip || '—').padEnd(6, ' ') +
        (snap.eff.prisma || '—');
      ctx.fillText(rowTxt, pad + 16, y + 58 + idx * 28);
    });

    y += 134;
    lines.forEach(function (ln) {
      ctx.font = ln[2] ? 'bold 18px system-ui, sans-serif' : '16px system-ui, sans-serif';
      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'left';
      var label = ln[0].length > 62 ? ln[0].slice(0, 61) + '…' : ln[0];
      ctx.fillText(label, pad, y);
      ctx.textAlign = 'right';
      ctx.fillText(ln[1], W - pad, y);
      y += 12;
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      y += 26;
    });

    y += 8;
    ctx.fillStyle = '#f8fafc';
    var payH = 126 + t.cristalinoOptions.length * 40;
    ctx.fillRect(pad, y, W - pad * 2, payH);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(pad, y, W - pad * 2, payH);

    var py = y + 30;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#115e59';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillText('MEDIOS DE PAGO' + (t.depositAmount > 0 ? ' (SOBRE SALDO)' : ''), pad + 16, py);
    py += 30;
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('Efectivo (' + t.cashDiscountPct + '% descuento):', pad + 16, py);
    ctx.textAlign = 'right';
    ctx.fillText(Q.fmtMoney(t.cashTotal), W - pad - 16, py);
    py += 28;
    ctx.fillStyle = '#0f172a';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Transferencia bancaria:', pad + 16, py);
    ctx.textAlign = 'right';
    ctx.fillText(Q.fmtMoney(t.transferTotal), W - pad - 16, py);
    py += 28;
    ctx.textAlign = 'left';
    var cardsStr = t.cardOptions.map(function (c) {
      return c.cuotas === 1 ? '1× ' + Q.fmtMoney(c.total) : c.cuotas + '× ' + Q.fmtMoney(c.cuotaMensual);
    }).join('  ·  ');
    ctx.fillText('Tarjeta: ' + cardsStr, pad + 16, py);
    t.cristalinoOptions.forEach(function (p) {
      py += 34;
      ctx.textAlign = 'left';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText('Plan Cristalino ' + p.cuotas + ' cuotas (' + p.surchargePct + '% rec.):', pad + 16, py);
      ctx.textAlign = 'right';
      ctx.fillText(Q.fmtMoney(p.cuotaMensual) + '/mes  (Total: ' + Q.fmtMoney(p.total) + ')', W - pad - 16, py);
    });

    ctx.textAlign = 'left';
    ctx.fillStyle = '#64748b';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Presupuesto válido hasta ' + snap.validaStr + '. Sujeto a verificación técnica en óptica.', pad, H - 20);

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

  async function save() {
    setError('#quote-error', '');
    var snap = buildQuoteSnapshot();
    if (snap.validation.errors.length) {
      setError('#quote-error', snap.validation.errors[0]);
      $('#quote-alerts').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (snap.validation.warnings.length) {
      var ok = confirm('Advertencias técnicas:\n• ' + snap.validation.warnings.join('\n• ') + '\n\n¿Guardar igualmente?');
      if (!ok) return;
    }

    var form = $('#extra-form');
    var extraFields = C.EXTRA_FIELDS.map(function (f) {
      var el = form.elements[f.key];
      return { key: f.key, label: f.label, value: (el && !el.disabled) ? el.value.trim() : '' };
    });
    var nameField = extraFields.find(function (f) { return f.key === C.PHOTO_NAME_FIELD; });
    var rxValues = snap.rx;
    var q = state.quote;
    var t = snap.totals;

    var newCatalogItems = [];
    var seenManual = {};
    ['od', 'oi'].forEach(function (eye) {
      if ((eye === 'od' && q.eyesMode === 'oi') || (eye === 'oi' && q.eyesMode === 'od')) return;
      var sel = q[eye];
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

    var cristalinoTxt = t.cristalinoOptions.map(function (p) {
      return p.cuotas + '×' + Q.fmtMoney(p.cuotaMensual) + ' (' + Q.fmtMoney(p.total) + ')';
    }).join(' | ');

    var quoteSummary = {
      uso: q.uso,
      eyesMode: q.eyesMode,
      odNombre: q.eyesMode === 'oi' ? '' : (snap.prodOd ? snap.prodOd.nombre : ''),
      odTipo: q.eyesMode === 'oi' ? '' : (snap.prodOd ? snap.prodOd.tipo : ''),
      odPrecio: q.eyesMode === 'oi' ? '' : String(t.odPrice),
      oiNombre: q.eyesMode === 'od' ? '' : (snap.prodOi ? snap.prodOi.nombre : ''),
      oiTipo: q.eyesMode === 'od' ? '' : (snap.prodOi ? snap.prodOi.tipo : ''),
      oiPrecio: q.eyesMode === 'od' ? '' : String(t.oiPrice),
      armazon: q.frame.mode === 'none' ? '' : frameSummaryText(),
      armazonPrecio: String(t.framePrice),
      descuento: t.discountAmount ? (String(t.discountAmount) + (q.discountNote ? ' (' + q.discountNote + ')' : '')) : '0',
      sena: String(t.depositAmount),
      totalLista: String(t.listTotal),
      totalEfectivo: String(t.cashTotal),
      planCristalino: cristalinoTxt
    };

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
      raw: state.ocr.raw || '',
      quoteSummary: quoteSummary,
      newCatalogItems: newCatalogItems
    };

    $('#btn-save').disabled = true;
    loading(true, 'Guardando en Drive y Sheets…');
    try {
      var res = await withAuth(function (tok) { return Api.save(Object.assign({ idToken: tok }, payload)); });
      if (newCatalogItems.length) state.catalogLoaded = false;
      showDone(res);
    } catch (e) {
      setError('#quote-error', e.message + ' (podés reintentar: no se duplica)');
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
    state.quoteInitialized = false;
    state.quote = defaultQuoteState();
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
    $('#extra-form').addEventListener('submit', toQuote);
    $('#btn-back-extra').addEventListener('click', function () { go('extra'); });
    $('#btn-save').addEventListener('click', save);
    $('#btn-print-quote').addEventListener('click', function () { window.print(); });
    $('#btn-done-print').addEventListener('click', function () { window.print(); });
    $('#btn-share-quote').addEventListener('click', shareOrDownloadQuoteImage);
    $('#btn-done-share').addEventListener('click', shareOrDownloadQuoteImage);

    $('#q-uso').addEventListener('change', function () {
      state.quote.uso = $('#q-uso').value;
      var dis = Q.USO_TO_DISENO[state.quote.uso] || 'Monofocal';
      state.quote.od.manual.diseno = dis;
      state.quote.oi.manual.diseno = dis;
      if (dis !== 'Monofocal') {
        state.quote.od.manual.tipo = 'Laboratorio';
        state.quote.oi.manual.tipo = 'Laboratorio';
      }
      syncQuoteControls();
    });
    $('#q-eyes').addEventListener('change', function () {
      state.quote.eyesMode = $('#q-eyes').value;
      syncQuoteControls();
    });
    ['od', 'oi'].forEach(function (eye) {
      $('#q-prod-' + eye).addEventListener('change', function () { onEyeSelectChange(eye); });
      ['nombre', 'tipo', 'diseno', 'indice', 'trat'].forEach(function (fld) {
        var el = $('#q-man-' + fld + '-' + eye);
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
          readManualAndPrice(eye);
          refreshQuotePreview();
        });
      });
      $('#q-man-save-' + eye).addEventListener('change', function () {
        readManualAndPrice(eye);
        refreshQuotePreview();
      });
      $('#q-price-' + eye).addEventListener('input', function () {
        readManualAndPrice(eye);
        refreshQuotePreview();
      });
    });

    $('#q-frame-mode').addEventListener('change', function () { syncFrameVisibility(); refreshQuotePreview(); });
    $('#q-frame-rim').addEventListener('change', function () { syncFrameVisibility(); refreshQuotePreview(); });
    $('#q-frame-detail').addEventListener('input', function () { state.quote.frame.detail = $('#q-frame-detail').value; refreshQuotePreview(); });
    $('#q-frame-price').addEventListener('input', function () { state.quote.frame.price = Math.max(0, Number($('#q-frame-price').value) || 0); refreshQuotePreview(); });
    $('#q-discount').addEventListener('input', function () { state.quote.discount = Math.max(0, Number($('#q-discount').value) || 0); refreshQuotePreview(); });
    $('#q-discount-note').addEventListener('input', function () { state.quote.discountNote = $('#q-discount-note').value; refreshQuotePreview(); });
    $('#q-deposit').addEventListener('input', function () { state.quote.deposit = Math.max(0, Number($('#q-deposit').value) || 0); refreshQuotePreview(); });

    $('#btn-new').addEventListener('click', function () { resetFlow(); go('capture'); });
    window.addEventListener('beforeunload', function (e) {
      if (state.screen === 'review' || state.screen === 'extra' || state.screen === 'quote') { e.preventDefault(); e.returnValue = ''; }
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
