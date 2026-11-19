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
    { key: 'fecha_receta', label: 'Fecha receta', group: 'encabezado', type: 'date' },
    { key: 'medico', label: 'Médico', group: 'encabezado', type: 'text' },
    { key: 'matricula', label: 'Matrícula', group: 'encabezado', type: 'text' }
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
function buildRow(existingHeaders, record) {
  var headers = (existingHeaders || []).map(function (h) { return String(h || '').trim(); });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  var added = [];
  record.forEach(function (pair) {
    if (headers.indexOf(pair[0]) < 0) { headers.push(pair[0]); added.push(pair[0]); }
  });
  var row = headers.map(function () { return ''; });
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
  return list.slice(0, 20).map(function (f) {
    var label = String((f && f.label) || '').replace(/[^\p{L}\p{N} ._()/?¿-]/gu, '').trim().slice(0, 40);
    var val = toSheetValue(f && f.value);
    var isName = (f && (f.key === 'nombre' || f.key === 'derivacion_doctor' || f.key === 'origen_nombre')) || /nombre|doctor/i.test(label);
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
  { codigo: 'STK-167-AR', nombre: 'Alto Índice 1.67 Antirreflejo', tipo: 'Stock', diseno: 'Monofocal', indice: '1.67', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 6, cilMax: 2, sumaMax: 10, precioMedioPar: 62000, activo: 'Sí' },
  { codigo: 'LAB-150-AR', nombre: 'Tallado Orgánico 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -14, esfMax: 12, cilMax: 6, sumaMax: 16, precioMedioPar: 42000, activo: 'Sí' },
  { codigo: 'LAB-159-BC', nombre: 'Tallado Policarbonato 1.59 Blue Cut', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.59', tratamiento: 'Blue Cut', esfMin: -16, esfMax: 12, cilMax: 6, sumaMax: 18, precioMedioPar: 58000, activo: 'Sí' },
  { codigo: 'LAB-167-AR', nombre: 'Tallado Alto Índice 1.67 Antirreflejo', tipo: 'Laboratorio', diseno: 'Monofocal', indice: '1.67', tratamiento: 'Antirreflejo', esfMin: -20, esfMax: 14, cilMax: 6, sumaMax: 22, precioMedioPar: 86000, activo: 'Sí' },
  { codigo: 'LAB-BIF-150', nombre: 'Bifocal Flap Top 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Bifocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 8, cilMax: 4, sumaMax: 12, precioMedioPar: 52000, activo: 'Sí' },
  { codigo: 'LAB-MUL-150', nombre: 'Multifocal Digital 1.50 Antirreflejo', tipo: 'Laboratorio', diseno: 'Multifocal', indice: '1.50', tratamiento: 'Antirreflejo', esfMin: -10, esfMax: 8, cilMax: 4, sumaMax: 12, precioMedioPar: 78000, activo: 'Sí' },
  { codigo: 'LAB-MUL-159', nombre: 'Multifocal Digital Poly 1.59 Blue Cut', tipo: 'Laboratorio', diseno: 'Multifocal', indice: '1.59', tratamiento: 'Blue Cut', esfMin: -12, esfMax: 8, cilMax: 5, sumaMax: 14, precioMedioPar: 105000, activo: 'Sí' },
  { codigo: 'LAB-OCU-156', nombre: 'Ocupacional 1.56 Blue Cut', tipo: 'Laboratorio', diseno: 'Ocupacional', indice: '1.56', tratamiento: 'Blue Cut', esfMin: -8, esfMax: 6, cilMax: 4, sumaMax: 10, precioMedioPar: 72000, activo: 'Sí' }
];

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
    var tipo = String(r[idx('Tipo')] || 'Stock').trim();
    items.push({
      codigo: String(r[idx('Codigo')] || ('CAT-' + i)).trim(),
      nombre: nombre,
      tipo: /^lab/i.test(tipo) ? 'Laboratorio' : 'Stock',
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

/** Valida y limpia un cristal cargado manualmente para guardarlo en Catalogo. */
function sanitizeCatalogItem(item, stamp) {
  if (!item || typeof item !== 'object') return null;
  var nombre = sanitizeCell(item.nombre, 120);
  if (!nombre) return null;
  var tipo = /^lab/i.test(String(item.tipo || '')) ? 'Laboratorio' : 'Stock';
  var diseno = ['Monofocal', 'Bifocal', 'Multifocal', 'Ocupacional'].indexOf(item.diseno) >= 0 ? item.diseno : 'Monofocal';
  if (diseno !== 'Monofocal') tipo = 'Laboratorio';
  var isLab = tipo === 'Laboratorio';
  var precio = Math.max(0, Math.round(Number(item.precioMedioPar || item.precio) || 0));
  var code = sanitizeCell(item.codigo, 30) || ('MAN-' + (stamp || Date.now().toString(36).toUpperCase()));
  return {
    codigo: code,
    nombre: nombre,
    tipo: tipo,
    diseno: diseno,
    indice: sanitizeCell(item.indice || '1.50', 12),
    tratamiento: sanitizeCell(item.tratamiento || '', 40),
    esfMin: isLab ? -20 : -10,
    esfMax: isLab ? 14 : 6,
    cilMax: isLab ? 6 : 2,
    sumaMax: isLab ? 22 : 10,
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
    formatPersonName: formatPersonName, toSheetValue: toSheetValue
  };
}
