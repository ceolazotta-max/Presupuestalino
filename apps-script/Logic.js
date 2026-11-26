/**
 * Logic.js — Lógica pura (sin servicios de Google).
 * Corre en Apps Script (scope global) y en Node (tests).
 * En el editor de Apps Script: pegar como archivo "Logic.gs".
 */

var TZ_DEFAULT = 'America/Argentina/Buenos_Aires';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var ALLOWED_MIME = ['image/jpeg', 'image/png'];
var GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Campos de la receta. Fuente única: schema Gemini, encabezados Sheet y UI. */
function buildRxFields() {
  var f = [
    { key: 'paciente', label: 'Paciente', group: 'encabezado', type: 'text' },
    { key: 'dni', label: 'DNI paciente', group: 'encabezado', type: 'text' },
    { key: 'fecha_receta', label: 'Fecha receta', group: 'encabezado', type: 'date' },
    { key: 'institucion', label: 'Institución', group: 'encabezado', type: 'text', required: true },
    { key: 'medico', label: 'Médico', group: 'encabezado', type: 'text' },
    { key: 'matricula', label: 'Matrícula', group: 'encabezado', type: 'text' },
    { key: 'matricula_esp', label: 'Matrícula Especialista (M.E.)', group: 'encabezado', type: 'text' }
  ];
  ['lejos', 'cerca'].forEach(function (dist) {
    ['od', 'oi'].forEach(function (eye) {
      ['esfera', 'cilindro', 'eje'].forEach(function (param) {
        f.push({
          key: dist + '_' + eye + '_' + param,
          label: cap(dist) + ' ' + eye.toUpperCase() + ' ' + cap(param),
          group: dist, eye: eye.toUpperCase(), param: param, type: param
        });
      });
    });
  });
  f.push(
    { key: 'adicion', label: 'Adición', group: 'otros', type: 'adicion' },
    { key: 'dip', label: 'DIP', group: 'otros', type: 'dip' },
    { key: 'prisma', label: 'Prisma / base', group: 'otros', type: 'text' },
    { key: 'ametropias', label: 'Ametropías', group: 'otros', type: 'text' },
    { key: 'tipo_lente', label: 'Tipo de lente', group: 'otros', type: 'text' },
    { key: 'tratamientos', label: 'Tratamientos', group: 'otros', type: 'text' },
    { key: 'observaciones', label: 'Observaciones', group: 'otros', type: 'longtext' }
  );
  return f;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Schema de salida estructurada para Gemini. */
function buildRxSchema(fields) {
  var conf = { type: 'STRING', enum: ['alta', 'media', 'baja'] };
  var props = {};
  fields.forEach(function (f) {
    props[f.key] = {
      type: 'OBJECT',
      properties: { valor: { type: 'STRING', nullable: true }, confianza: conf },
      required: ['valor', 'confianza']
    };
  });
  return {
    type: 'OBJECT',
    properties: {
      es_receta_optica: { type: 'BOOLEAN' },
      campos: { type: 'OBJECT', properties: props, required: fields.map(function (f) { return f.key; }) },
      anotaciones_extra: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { texto: { type: 'STRING' }, ubicacion: { type: 'STRING' }, confianza: conf },
          required: ['texto', 'confianza']
        }
      }
    },
    required: ['es_receta_optica', 'campos', 'anotaciones_extra']
  };
}

/** "José Pérez-Núñez" → "Jose-Perez-Nunez". */
function normalizeName(s, maxLen) {
  maxLen = maxLen || 60;
  var out = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return out || 'sin-nombre';
}

/** stamp = "YYYY-MM-DD_HHmmss" (ya formateado en zona AR). */
function buildPhotoFileName(stamp, name, mime) {
  var ext = mime === 'image/png' ? 'png' : 'jpg';
  return stamp + '_' + normalizeName(name) + '.' + ext;
}

/** Decodifica payload JWT SIN verificar firma (solo pre-chequeo barato). */
function decodeJwtPayload(token, b64urlToString) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Token mal formado');
  var payload = JSON.parse(b64urlToString(parts[1]));
  if (!payload || typeof payload !== 'object') throw new Error('Payload inválido');
  return payload;
}

/**
 * Valida claims de un ID token de Google.
 * cfg: { clientId, domain, allowedEmails: [] }
 * Retorna { ok, code, reason, email }.
 */
function precheckClaims(c, cfg, nowSec) {
  function fail(code, reason) { return { ok: false, code: code, reason: reason }; }
  if (!c) return fail(401, 'Sin claims');
  if (GOOGLE_ISSUERS.indexOf(c.iss) < 0) return fail(401, 'Emisor inválido');
  if (!cfg.clientId || c.aud !== cfg.clientId) return fail(401, 'Audiencia inválida');
  if (!(Number(c.exp) > nowSec)) return fail(401, 'Token vencido');
  if (!(c.email_verified === true || c.email_verified === 'true')) return fail(401, 'Email no verificado');
  var email = String(c.email || '').toLowerCase();
  if (!email) return fail(401, 'Sin email');
  var hasDomain = Boolean(cfg.domain);
  var hasAllowlist = Boolean(cfg.allowedEmails && cfg.allowedEmails.length);
  if (!hasDomain && !hasAllowlist) return fail(500, 'Sin filtro de acceso configurado');
  if (hasDomain && String(c.hd || '').toLowerCase() !== cfg.domain.toLowerCase()) {
    return fail(403, 'Cuenta fuera del dominio corporativo');
  }
  if (hasAllowlist && cfg.allowedEmails.indexOf(email) < 0) {
    return fail(403, 'Usuario no autorizado');
  }
  return { ok: true, email: email };
}

/** "data:image/jpeg;base64,AAAA" → { mime, data, bytes }. Lanza si inválido. */
function parseDataUrl(s) {
  var m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw new Error('Imagen inválida');
  var mime = m[1].toLowerCase();
  if (ALLOWED_MIME.indexOf(mime) < 0) throw new Error('Formato no permitido: ' + mime);
  var data = m[2];
  var pad = (data.match(/=+$/) || [''])[0].length;
  var bytes = Math.floor(data.length * 3 / 4) - pad;
  if (bytes > MAX_IMAGE_BYTES) throw new Error('Imagen demasiado grande');
  return { mime: mime, data: data, bytes: bytes };
}

/** Texto seguro para celda: recorta y neutraliza fórmulas (=, @, +/- no numérico). */
function sanitizeCell(v, maxLen) {
  maxLen = maxLen || 1000;
  if (v === null || v === undefined) return '';
  var s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLen);
  if (/^[=@]/.test(s) || /^[+-](?![\d.,]+$)/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;
  return s;
}

/** Convierte valores puramente numéricos (ej. "-2.25", "+1,50", "26000") a Number real para Google Sheets. */
function toSheetValue(v, maxLen) {
  var s = sanitizeCell(v, maxLen);
  if (/^[+-]?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return s;
}

/** Normaliza nombres propios: quita "Dr./Dra." y comas ("PEREZ, JUAN") → "Perez Juan". */
function formatPersonName(s) {
  var t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(dr\.?|dra\.?)\s+/i, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.split(' ').map(function (w) {
    return w.charAt(0).toLocaleUpperCase('es-AR') + w.slice(1).toLocaleLowerCase('es-AR');
  }).join(' ');
}

/**
 * Mapea registro a fila según encabezados existentes.
 * record: [[header, value], ...] en orden preferido.
 * Retorna { headers (completos), row, added (nuevos) }.
 */
function buildRow(existingHeaders, record, existingRow) {
  var headers = (existingHeaders || []).map(function (h) { return String(h || '').trim(); });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  var added = [];
  record.forEach(function (pair) {
    if (headers.indexOf(pair[0]) < 0) { headers.push(pair[0]); added.push(pair[0]); }
  });
  var prev = Array.isArray(existingRow) ? existingRow : [];
  var row = headers.map(function (_, i) { return i < prev.length && prev[i] !== undefined ? prev[i] : ''; });
  record.forEach(function (pair) { row[headers.indexOf(pair[0])] = pair[1]; });
  return { headers: headers, row: row, added: added };
}

function isValidUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
}

function parseCsvList(s) {
  return String(s || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
}

function rateKey(action, email, nowMs) {
  return 'rl_' + action + '_' + email + '_' + Math.floor(nowMs / 3600000);
}

/** Valida y limpia campos extra enviados por el cliente. */
function sanitizeExtraFields(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 30).map(function (f) {
    var key = f && f.key;
    var label = String((f && f.label) || '').replace(/[^\p{L}\p{N} ._()/?¿-]/gu, '').trim().slice(0, 40);
    if (key === 'nombre' || /^apellido y nombre cliente$/i.test(label)) {
      label = 'Nombre cliente';
    } else if (key === 'dni' || /^dni$/i.test(label)) {
      label = 'DNI';
    } else if (key === 'convenio' || /^convenio$/i.test(label)) {
      label = 'Convenio';
    } else if (key === 'convenio_otro' || /^cu[aá]l convenio$/i.test(label)) {
      label = 'Cuál Convenio';
    } else if (key === 'origen_nombre' || /^nombre$/i.test(label)) {
      label = 'Nombre Recomendador';
    }
    var val = toSheetValue(f && f.value);
    if (key === 'dni' || /^dni$/i.test(label)) {
      var digits = String((f && f.value) == null ? '' : f.value).replace(/\D+/g, '');
      val = digits ? toSheetValue(digits, 20) : '';
    }
    var isName = (f && (key === 'nombre' || key === 'derivacion_doctor' || key === 'derivacion_secretaria' || key === 'origen_nombre')) ||
      (!/^convenio|cu[aá]l convenio$/i.test(label) && /nombre|doctor|secretaria|recomendador/i.test(label));
    if (typeof val === 'string' && val && isName) val = formatPersonName(val);
    return { label: label, value: val };
  }).filter(function (f) { return f.label; });
}

var CATALOG_HEADERS = [
  'Codigo', 'Nombre', 'Tipo', 'Diseno', 'Indice', 'Tratamiento',
  'Esf_Min', 'Esf_Max', 'Cil_Max', 'Suma_Max', 'Precio_Medio_Par', 'Activo'
];

var SEED_CATALOG_ITEMS = [
  { codigo: 'STK-150-BL', nombre: 'Orgánico 1.50 Blanco', tipo: 'Stock', diseno: 'Monofocal', indice: '1.50', tratamiento: 'Blanco', esfMin: -6, esfMax: 4, cilMax: 2, sumaMax: 6, precioMedioPar: 18000, activo: 'Sí' },
  { codigo: 'STK-150-AR', nombre: 'Orgánico 1.50 Antirreflejo', tipo: 'Stock', diseno: 'Monofocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -8, esfMax: 6, cilMax: 2, sumaMax: 8, precioMedioPar: 26000, activo: 'Sí' },
  { codigo: 'STK-156-BC', nombre: 'Orgánico 1.56 Blue Cut', tipo: 'Stock', diseno: 'Monofocal', indice: '1.56', tratamiento: 'Blue Cut', esfMin: -8, esfMax: 6, cilMax: 2, sumaMax: 8, precioMedioPar: 34000, activo: 'Sí' },
  { codigo: 'STK-156-FC', nombre: 'Orgánico 1.56 Fotocromático', tipo: 'Stock', diseno: 'Monofocal', indice: '1.56', tratamiento: 'Fotocromático', esfMin: -6, esfMax: 4, cilMax: 2, sumaMax: 6, precioMedioPar: 46000, activo: 'Sí' },
  { codigo: 'STK-159-AR', nombre: 'Policarbonato 1.59 Antirreflejo', tipo: 'Stock', diseno: 'Monofocal', indice: '1.59', tratamiento: 'Antirreflejo', esfMin: -8, esfMax: 6, cilMax: 2, sumaMax: 8, precioMedioPar: 38000, activo: 'Sí' },
  { codigo: 'STK-167-AR', nombre: 'Alto Índice 1.67 Antirreflejo', tipo: 'Stock', diseno: 'Monofocal', indice: '1.67', tratamiento: 'Antirreflejo', esfMin: -8, esfMax: 6, cilMax: 2, sumaMax: 8, precioMedioPar: 62000, activo: 'Sí' },
  { codigo: 'EXT-156-AR', nombre: 'Orgánico 1.56 Rango Extendido Antirreflejo', tipo: 'Rango Extendido', diseno: 'Monofocal', indice: '1.56', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 6, cilMax: 4, sumaMax: 10, precioMedioPar: 36000, activo: 'Sí' },
  { codigo: 'EXT-159-BC', nombre: 'Policarbonato 1.59 Rango Extendido Blue Cut', tipo: 'Rango Extendido', diseno: 'Monofocal', indice: '1.59', tratamiento: 'Blue Cut', esfMin: -10, esfMax: 6, cilMax: 4, sumaMax: 10, precioMedioPar: 48000, activo: 'Sí' },
  { codigo: 'LAB-150-AR', nombre: 'Tallado Orgánico 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -14, esfMax: 12, cilMax: 6, sumaMax: 16, precioMedioPar: 42000, activo: 'Sí' },
  { codigo: 'LAB-159-BC', nombre: 'Tallado Policarbonato 1.59 Blue Cut', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.59', tratamiento: 'Blue Cut', esfMin: -16, esfMax: 12, cilMax: 6, sumaMax: 18, precioMedioPar: 58000, activo: 'Sí' },
  { codigo: 'LAB-167-AR', nombre: 'Tallado Alto Índice 1.67 Antirreflejo', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.67', tratamiento: 'Antirreflejo', esfMin: -20, esfMax: 14, cilMax: 6, sumaMax: 22, precioMedioPar: 86000, activo: 'Sí' },
  { codigo: 'LAB-BIF-150', nombre: 'Bifocal Flap Top 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Bifocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 8, cilMax: 4, sumaMax: 12, precioMedioPar: 52000, activo: 'Sí' },
  { codigo: 'LAB-MUL-150', nombre: 'Multifocal Digital 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Multifocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 8, cilMax: 4, sumaMax: 12, precioMedioPar: 78000, activo: 'Sí' },
  { codigo: 'LAB-MUL-159', nombre: 'Multifocal Digital Poly 1.59 Blue Cut', tipo: 'Laboratorio', diseno: 'Multifocal', indice: '1.59', tratamiento: 'Blue Cut', esfMin: -12, esfMax: 8, cilMax: 5, sumaMax: 14, precioMedioPar: 105000, activo: 'Sí' },
  { codigo: 'LAB-OCU-156', nombre: 'Ocupacional 1.56 Blue Cut', tipo: 'Laboratorio', diseno: 'Ocupacional', indice: '1.56', tratamiento: 'Blue Cut', esfMin: -8, esfMax: 6, cilMax: 4, sumaMax: 10, precioMedioPar: 72000, activo: 'Sí' }
];

var PAYMENT_HEADERS = ['Medio', 'Marca_Banco', 'Plan', 'Cuotas', 'Recargo_Porcentaje', 'Activo'];

var SEED_PAYMENT_ROWS = [
  ['Efectivo', '', 'Contado', 1, -10, 'Sí'],
  ['Transferencia', '', 'Contado', 1, 0, 'Sí'],
  ['Tarjeta', 'Visa / Mastercard', '1 cuota', 1, 0, 'Sí'],
  ['Tarjeta', 'Visa / Mastercard', '3 cuotas', 3, 15, 'Sí'],
  ['Tarjeta', 'Visa / Mastercard', '6 cuotas', 6, 30, 'Sí'],
  ['Tarjeta', 'Naranja X', 'Plan Z (3 cuotas)', 3, 10, 'Sí'],
  ['Tarjeta', 'Naranja X', '6 cuotas', 6, 25, 'Sí'],
  ['Plan Cristalino', '', '2 cuotas', 2, 12, 'Sí'],
  ['Plan Cristalino', '', '3 cuotas', 3, 20, 'Sí'],
  ['Plan Cristalino', '', '6 cuotas', 6, 42, 'Sí']
];

var CONVENIOS_HEADERS = ['Nombre_Convenio', 'Activo'];

var SEED_CONVENIOS_ROWS = [
  ['Sin convenio / Particular', 'Sí'],
  ['PAMI', 'Sí'],
  ['APROSS', 'Sí'],
  ['OSDE', 'Sí'],
  ['OSECAC', 'Sí']
];

function isRowActive_(raw) {
  var s = String(raw == null ? 'Sí' : raw).trim().toLowerCase();
  if (!s) return true;
  return ['no', 'false', '0', 'inactivo'].indexOf(s) < 0;
}

/** Convierte filas de la pestaña Convenios en lista de nombres activos únicos. */
function parseConveniosRows(rows) {
  var fallback = SEED_CONVENIOS_ROWS.map(function (r) { return r[0]; });
  if (!Array.isArray(rows) || rows.length < 2) return fallback;
  var headers = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var nameCol = headers.indexOf('nombre_convenio');
  if (nameCol < 0) nameCol = 0;
  var activeCol = headers.indexOf('activo');
  var seen = {};
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var nom = String(r[nameCol] == null ? '' : r[nameCol]).trim();
    if (!nom || /^otro$/i.test(nom)) continue;
    if (activeCol >= 0 && !isRowActive_(r[activeCol])) continue;
    var norm = nom.toLowerCase();
    if (seen[norm]) continue;
    seen[norm] = true;
    out.push(nom);
  }
  return out.length ? out : fallback;
}

function normalizeCatalogTipo_(raw) {
  var s = String(raw || '').trim();
  if (/lab/i.test(s)) return 'Laboratorio';
  if (/extend|rango/i.test(s)) return 'Rango Extendido';
  return 'Stock';
}

function numOrDefault_(v, def) {
  var n = Number(String(v === undefined || v === null ? '' : v).replace(',', '.'));
  return isFinite(n) && String(v).trim() !== '' ? n : def;
}

/** Convierte filas de la pestaña Catalogo (fila 1 = encabezados) en objetos de producto activos. */
function parseCatalogRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  var headers = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var idx = function (name) { return headers.indexOf(name.toLowerCase()); };
  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var nombre = String(r[idx('Nombre')] || '').trim();
    if (!nombre) continue;
    var activo = String(r[idx('Activo')] || 'Sí').trim().toLowerCase();
    if (activo === 'no' || activo === 'false' || activo === '0') continue;
    var tipo = normalizeCatalogTipo_(r[idx('Tipo')]);
    items.push({
      codigo: String(r[idx('Codigo')] || ('CAT-' + i)).trim(),
      nombre: nombre,
      tipo: tipo,
      diseno: String(r[idx('Diseno')] || 'Monofocal').trim(),
      indice: String(r[idx('Indice')] || '1.50').trim(),
      tratamiento: String(r[idx('Tratamiento')] || '').trim(),
      esfMin: numOrDefault_(r[idx('Esf_Min')], -10),
      esfMax: numOrDefault_(r[idx('Esf_Max')], 6),
      cilMax: Math.abs(numOrDefault_(r[idx('Cil_Max')], 2)),
      sumaMax: Math.abs(numOrDefault_(r[idx('Suma_Max')], 10)),
      precioMedioPar: Math.max(0, numOrDefault_(r[idx('Precio_Medio_Par')], 0)),
      activo: 'Sí'
    });
  }
  return items;
}

/** Convierte filas de la pestaña Medios_Pago en configuración de descuentos/cuotas. */
function parsePaymentRows(rows) {
  var cfg = {
    cashDiscountPct: 10,
    transferSurchargePct: 0,
    cardPlans: [],
    cristalinoPlans: []
  };
  if (!Array.isArray(rows) || rows.length < 2) {
    return {
      cashDiscountPct: 10,
      transferSurchargePct: 0,
      cardPlans: [
        { marca: 'Visa / Mastercard', plan: '1 cuota', cuotas: 1, surchargePct: 0 },
        { marca: 'Visa / Mastercard', plan: '3 cuotas', cuotas: 3, surchargePct: 15 },
        { marca: 'Visa / Mastercard', plan: '6 cuotas', cuotas: 6, surchargePct: 30 },
        { marca: 'Naranja X', plan: 'Plan Z (3 cuotas)', cuotas: 3, surchargePct: 10 },
        { marca: 'Naranja X', plan: '6 cuotas', cuotas: 6, surchargePct: 25 }
      ],
      cristalinoPlans: [
        { cuotas: 2, plan: '2 cuotas', surchargePct: 12 },
        { cuotas: 3, plan: '3 cuotas', surchargePct: 20 },
        { cuotas: 6, plan: '6 cuotas', surchargePct: 42 }
      ]
    };
  }
  var headers = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var idx = function (name) { return headers.indexOf(name.toLowerCase()); };
  var marcaCol = idx('Marca_Banco');
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i] || [];
    var medio = String(r[idx('Medio')] || '').trim();
    if (!medio) continue;
    var activo = String(r[idx('Activo')] || 'Sí').trim().toLowerCase();
    if (activo === 'no' || activo === 'false' || activo === '0') continue;
    var marca = marcaCol >= 0 ? String(r[marcaCol] || '').trim() : '';
    var plan = String(r[idx('Plan')] || '').trim();
    var cuotas = Math.max(1, Math.round(numOrDefault_(r[idx('Cuotas')], 1)));
    var rec = numOrDefault_(r[idx('Recargo_Porcentaje')], 0);
    if (/efectivo/i.test(medio)) {
      cfg.cashDiscountPct = rec < 0 ? -rec : rec;
    } else if (/transfer/i.test(medio)) {
      cfg.transferSurchargePct = rec;
    } else if (/cristalino/i.test(medio)) {
      cfg.cristalinoPlans.push({ cuotas: cuotas, plan: plan || (cuotas + ' cuotas'), surchargePct: rec });
    } else if (/tarjeta/i.test(medio)) {
      var inferredMarca = marca || medio.replace(/^tarjeta\s*[-·:]?\s*/i, '').trim() || 'General';
      cfg.cardPlans.push({ marca: inferredMarca, cuotas: cuotas, plan: plan || (cuotas + ' cuotas'), surchargePct: rec });
    }
  }
  var brandOrder = {};
  var nextOrder = 0;
  cfg.cardPlans.forEach(function (p) {
    if (!(p.marca in brandOrder)) brandOrder[p.marca] = nextOrder++;
  });
  cfg.cardPlans.sort(function (a, b) {
    if (a.marca !== b.marca) return brandOrder[a.marca] - brandOrder[b.marca];
    return a.cuotas - b.cuotas;
  });
  cfg.cristalinoPlans.sort(function (a, b) { return a.cuotas - b.cuotas; });
  if (!cfg.cardPlans.length) cfg.cardPlans = [{ marca: 'General', plan: '1 cuota', cuotas: 1, surchargePct: 0 }];
  if (!cfg.cristalinoPlans.length) cfg.cristalinoPlans = [{ cuotas: 2, plan: '2 cuotas', surchargePct: 12 }];
  return cfg;
}

/** Valida y limpia un cristal cargado manualmente para guardarlo en Catalogo. */
function sanitizeCatalogItem(item, stamp) {
  if (!item || typeof item !== 'object') return null;
  var nombre = sanitizeCell(item.nombre, 120);
  if (!nombre) return null;
  var tipo = normalizeCatalogTipo_(item.tipo);
  var diseno = ['Monofocal', 'Bifocal', 'Multifocal', 'Ocupacional'].indexOf(item.diseno) >= 0 ? item.diseno : 'Monofocal';
  if (diseno !== 'Monofocal') tipo = 'Laboratorio';
  var isLab = tipo === 'Laboratorio';
  var isExt = tipo === 'Rango Extendido';
  var precio = Math.max(0, Math.round(Number(item.precioMedioPar || item.precio) || 0));
  var code = sanitizeCell(item.codigo, 30) || ('MAN-' + (stamp || Date.now().toString(36).toUpperCase()));
  return {
    codigo: code,
    nombre: nombre,
    tipo: tipo,
    diseno: diseno,
    indice: sanitizeCell(item.indice || '1.50', 12),
    tratamiento: sanitizeCell(item.tratamiento || '', 40),
    esfMin: isLab ? -20 : (isExt ? -10 : -8),
    esfMax: isLab ? 14 : 6,
    cilMax: isLab ? 6 : (isExt ? 4 : 2),
    sumaMax: isLab ? 22 : (isExt ? 10 : 8),
    precioMedioPar: precio,
    activo: 'Sí'
  };
}

function catalogItemToRow(it) {
  return [
    it.codigo, it.nombre, it.tipo, it.diseno, it.indice, it.tratamiento,
    it.esfMin, it.esfMax, it.cilMax, it.sumaMax, it.precioMedioPar, it.activo || 'Sí'
  ];
}

/** Normaliza la respuesta JSON de Gemini al esquema esperado por la UI. */
function normalizeOcrResult(rawObj, fields) {
  rawObj = (rawObj && typeof rawObj === 'object') ? rawObj : {};
  fields = Array.isArray(fields) ? fields : buildRxFields();
  var rawCampos = (rawObj.campos && typeof rawObj.campos === 'object') ? rawObj.campos : rawObj;
  var validConf = { alta: 'alta', media: 'media', baja: 'baja' };
  var campos = {};

  fields.forEach(function (f) {
    var cell = rawCampos[f.key];
    var val = null;
    var conf = 'baja';
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      val = (cell.valor === undefined || cell.valor === null || String(cell.valor).trim() === '') ? null : String(cell.valor).trim();
      conf = validConf[String(cell.confianza || '').toLowerCase()] || (val ? 'media' : 'baja');
    } else if (cell !== undefined && cell !== null && String(cell).trim() !== '') {
      val = String(cell).trim();
      conf = 'media';
    }
    if ((f.key === 'paciente' || f.key === 'medico') && val) {
      val = formatPersonName(val);
    }
    campos[f.key] = { valor: val, confianza: conf };
  });

  var rawExtras = Array.isArray(rawObj.anotaciones_extra) ? rawObj.anotaciones_extra : [];
  var extras = rawExtras.map(function (a) {
    if (typeof a === 'string') return { texto: a.trim(), ubicacion: '', confianza: 'media' };
    if (!a || typeof a !== 'object') return null;
    return {
      texto: String(a.texto || '').trim(),
      ubicacion: String(a.ubicacion || '').trim(),
      confianza: validConf[String(a.confianza || '').toLowerCase()] || 'media'
    };
  }).filter(function (a) { return a && a.texto; });

  return {
    es_receta_optica: rawObj.es_receta_optica !== false,
    campos: campos,
    anotaciones_extra: extras
  };
}

/** Extrae y parsea el JSON de la respuesta de Gemini ignorando bloques thought y fences Markdown. */
function extractOcrJson(geminiData) {
  var cand = geminiData && geminiData.candidates && geminiData.candidates[0];
  var finishReason = String((cand && cand.finishReason) || '');
  var parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  var nonThought = parts
    .filter(function (p) { return p && !p.thought && typeof p.text === 'string'; })
    .map(function (p) { return p.text; })
    .join('\n')
    .trim();
  var text = nonThought || parts
    .filter(function (p) { return p && typeof p.text === 'string'; })
    .map(function (p) { return p.text; })
    .join('\n')
    .trim();
  if (!text) {
    return {
      ok: false,
      reason: finishReason === 'MAX_TOKENS' ? 'truncated' : 'empty',
      finishReason: finishReason,
      raw: ''
    };
  }
  var cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  var parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (e2) { parsed = null; }
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, parsed: parsed, raw: text, finishReason: finishReason };
  }
  return {
    ok: false,
    reason: finishReason === 'MAX_TOKENS' ? 'truncated' : 'invalid_json',
    finishReason: finishReason,
    raw: text.slice(0, 300)
  };
}

/** Orden de modos de thinking a intentar según familia de modelo Gemini. */
function thinkingModesForModel(model, cachedMode) {
  var base = /^gemini-2\.5-/i.test(String(model || ''))
    ? ['budget0', 'none']
    : ['minimal', 'low', 'budget0', 'none'];
  if (cachedMode && base.indexOf(cachedMode) >= 0) {
    return [cachedMode].concat(base.filter(function (m) { return m !== cachedMode; }));
  }
  return base;
}

/** Construye generationConfig REST v1beta (enums thinkingLevel en MAYÚSCULAS). */
function buildOcrGenerationConfig(mode, maxTokensOverride) {
  var table = {
    minimal: { tokens: 1400, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    low: { tokens: 2048, thinkingConfig: { thinkingLevel: 'LOW' } },
    budget0: { tokens: 1400, thinkingConfig: { thinkingBudget: 0 } },
    none: { tokens: 1800, thinkingConfig: null }
  };
  var spec = table[mode] || table.none;
  var cfg = {
    temperature: 0,
    responseMimeType: 'application/json',
    maxOutputTokens: maxTokensOverride || spec.tokens
  };
  if (spec.thinkingConfig) cfg.thinkingConfig = spec.thinkingConfig;
  return cfg;
}

function normSearch_(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function onlyDigits_(s) {
  return String(s == null ? '' : s).replace(/\D+/g, '');
}

/** Formatea dígitos de DNI con separador de miles ("99999999" → "99.999.999"). */
function formatDniDots(s) {
  var digits = onlyDigits_(s).slice(0, 11);
  return digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
}

/** Formatea cualquier fecha/epoch/ISO a hora Argentina (GMT-3) YYYY-MM-DD HH:mm:ss. */
function formatArTimestamp(input) {
  if (input == null || input === '') return '';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input.trim())) {
    return input.trim();
  }
  var d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input).trim();
  var ar = new Date(d.getTime() - 3 * 3600000);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return ar.getUTCFullYear() + '-' + p(ar.getUTCMonth() + 1) + '-' + p(ar.getUTCDate()) + ' ' +
    p(ar.getUTCHours()) + ':' + p(ar.getUTCMinutes()) + ':' + p(ar.getUTCSeconds());
}

/** Busca y agrupa presupuestos en filas de Google Sheets por Nombre cliente o DNI, ordenados de más nuevo a más viejo. */
function searchBudgetsInSheetRows(rows, query) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  var qNorm = normSearch_(query);
  var qDigits = onlyDigits_(query);
  if (qNorm.length < 2 && qDigits.length < 3) return [];
  var qTokens = qNorm ? qNorm.split(' ').filter(Boolean) : [];

  var headers = rows[0].map(function (h) { return String(h || '').trim(); });
  var hdrMap = {};
  headers.forEach(function (h, i) {
    var k = normSearch_(h);
    if (k && !(k in hdrMap)) hdrMap[k] = i;
  });

  function cellAny(r, names) {
    for (var i = 0; i < names.length; i++) {
      var idx = hdrMap[normSearch_(names[i])];
      if (idx !== undefined && r[idx] !== undefined && r[idx] !== null && r[idx] !== '') {
        return String(r[idx]).trim();
      }
    }
    return '';
  }

  var rxFields = buildRxFields();
  var groups = [];
  var byKey = {};

  for (var ri = 1; ri < rows.length; ri++) {
    var r = rows[ri] || [];
    if (!r.some(function (c) { return c !== '' && c !== null && c !== undefined; })) continue;
    var rawUuid = cellAny(r, ['UUID']);
    var groupKey = rawUuid || ('legacy-row-' + (ri + 1));

    var nombreCli = cellAny(r, ['Nombre cliente', 'Apellido y Nombre cliente']);
    var paciente = cellAny(r, ['Paciente']);
    var dniCli = cellAny(r, ['DNI']);
    var dniPac = cellAny(r, ['DNI paciente']);

    if (!byKey[groupKey]) {
      var extraMap = {
        nombre: nombreCli || paciente,
        dni: dniCli || dniPac,
        telefono: cellAny(r, ['Teléfono', 'Telefono']),
        email: cellAny(r, ['Email cliente', 'Email']),
        convenio: cellAny(r, ['Convenio']),
        convenio_otro: cellAny(r, ['Cuál Convenio', 'Cual Convenio']),
        derivacion: cellAny(r, ['Derivación', 'Derivacion']),
        derivacion_doctor: cellAny(r, ['Nombre Doctor']),
        derivacion_secretaria: cellAny(r, ['Nombre Secretaria']),
        origen: cellAny(r, ['Origen']),
        origen_nombre: cellAny(r, ['Nombre Recomendador', 'Nombre']),
        origen_red: cellAny(r, ['Red Social']),
        notas: cellAny(r, ['Notas']),
        vendedor: cellAny(r, ['Vendedor'])
      };
      var rxMap = {};
      rxFields.forEach(function (f) { rxMap[f.key] = cellAny(r, [f.label]); });
      if (!rxMap.paciente && nombreCli) rxMap.paciente = nombreCli;
      if (!rxMap.dni && dniCli) rxMap.dni = dniCli;
      var annStr = cellAny(r, ['Anotaciones extra']);
      var extrasList = annStr ? annStr.split('; ').map(function (s) { return s.trim(); }).filter(Boolean) : [];

      byKey[groupKey] = {
        uuid: rawUuid,
        groupKey: groupKey,
        rowIdx: ri + 1,
        lastRowIdx: ri + 1,
        fecha: cellAny(r, ['Última actualización', 'Timestamp']),
        estado: cellAny(r, ['Estado']) || 'PRESUPUESTADO',
        nombre: nombreCli || paciente || '—',
        dni: dniCli || dniPac,
        fotoUrl: cellAny(r, ['Foto']),
        rx: rxMap,
        extras: extrasList,
        extraMap: extraMap,
        options: []
      };
      groups.push(byKey[groupKey]);
    }

    var grp = byKey[groupKey];
    grp.lastRowIdx = ri + 1;
    var fAct = cellAny(r, ['Última actualización', 'Timestamp']);
    if (fAct && (!grp.fecha || fAct > grp.fecha)) grp.fecha = fAct;
    var est = cellAny(r, ['Estado']);
    if (est && !(grp.estado === 'VENTA CONCRETADA' && est === 'NO ELEGIDA')) grp.estado = est;
    if (!grp.nombre || grp.nombre === '—') grp.nombre = nombreCli || paciente || '—';
    if (!grp.dni) grp.dni = dniCli || dniPac;
    if (!grp.fotoUrl) grp.fotoUrl = cellAny(r, ['Foto']);

    var uso = cellAny(r, ['Uso anteojo']);
    var odNom = cellAny(r, ['½ Par OD', '1/2 Par OD']);
    var oiNom = cellAny(r, ['½ Par OI', '1/2 Par OI']);
    var totLst = cellAny(r, ['Total Lista']);
    if (uso || odNom || oiNom || totLst) {
      grp.options.push({
        opcion: Number(cellAny(r, ['Opción #', 'Opcion #'])) || (grp.options.length + 1),
        grupo: Number(cellAny(r, ['Grupo #'])) || 0,
        uso: uso || 'lejos',
        eyesMode: cellAny(r, ['Ojos cotizados']) || 'both',
        odNombre: odNom,
        odTipo: cellAny(r, ['Tipo OD']),
        odPrecio: cellAny(r, ['Precio ½ OD', 'Precio 1/2 OD']),
        oiNombre: oiNom,
        oiTipo: cellAny(r, ['Tipo OI']),
        oiPrecio: cellAny(r, ['Precio ½ OI', 'Precio 1/2 OI']),
        armazon: cellAny(r, ['Armazón', 'Armazon']),
        armazonMarca: cellAny(r, ['Armazón Marca', 'Armazon Marca']),
        armazonModelo: cellAny(r, ['Armazón Modelo', 'Armazon Modelo']),
        armazonColor: cellAny(r, ['Armazón Color', 'Armazon Color']),
        armazonPrecio: cellAny(r, ['Precio Armazón', 'Precio Armazon']),
        descuento: cellAny(r, ['Descuento / OS']),
        sena: cellAny(r, ['Seña', 'Sena']),
        totalLista: totLst,
        grupoVendido: cellAny(r, ['Grupo Vendido'])
      });
    }
  }

  var matched = groups.filter(function (g) {
    var nameHay = normSearch_(g.nombre + ' ' + (g.rx && g.rx.paciente || ''));
    var nameHit = qTokens.length > 0 && qTokens.every(function (tk) { return nameHay.indexOf(tk) >= 0; });
    var dniHay = onlyDigits_(g.dni + ' ' + (g.rx && g.rx.dni || ''));
    var dniHit = qDigits.length >= 3 && dniHay.indexOf(qDigits) >= 0;
    return nameHit || dniHit;
  });

  matched.forEach(function (g) {
    g.options.sort(function (a, b) { return a.opcion - b.opcion; });
  });
  matched.sort(function (a, b) {
    var cmp = String(b.fecha || '').localeCompare(String(a.fecha || ''));
    if (cmp !== 0) return cmp;
    return b.lastRowIdx - a.lastRowIdx;
  });
  return matched.slice(0, 30);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildRxFields: buildRxFields, buildRxSchema: buildRxSchema, normalizeName: normalizeName,
    buildPhotoFileName: buildPhotoFileName, decodeJwtPayload: decodeJwtPayload,
    precheckClaims: precheckClaims, parseDataUrl: parseDataUrl, sanitizeCell: sanitizeCell,
    buildRow: buildRow, isValidUuid: isValidUuid, parseCsvList: parseCsvList, rateKey: rateKey,
    sanitizeExtraFields: sanitizeExtraFields, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    CATALOG_HEADERS: CATALOG_HEADERS, SEED_CATALOG_ITEMS: SEED_CATALOG_ITEMS,
    parseCatalogRows: parseCatalogRows, sanitizeCatalogItem: sanitizeCatalogItem,
    catalogItemToRow: catalogItemToRow, normalizeOcrResult: normalizeOcrResult,
    extractOcrJson: extractOcrJson, thinkingModesForModel: thinkingModesForModel,
    buildOcrGenerationConfig: buildOcrGenerationConfig,
    searchBudgetsInSheetRows: searchBudgetsInSheetRows,
    formatDniDots: formatDniDots,
    formatPersonName: formatPersonName, toSheetValue: toSheetValue,
    PAYMENT_HEADERS: PAYMENT_HEADERS, SEED_PAYMENT_ROWS: SEED_PAYMENT_ROWS,
    parsePaymentRows: parsePaymentRows,
    CONVENIOS_HEADERS: CONVENIOS_HEADERS, SEED_CONVENIOS_ROWS: SEED_CONVENIOS_ROWS,
    parseConveniosRows: parseConveniosRows,
    formatArTimestamp: formatArTimestamp
  };
}
