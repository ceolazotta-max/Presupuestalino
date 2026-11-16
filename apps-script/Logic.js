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
  if (cfg.domain && String(c.hd || '').toLowerCase() !== cfg.domain.toLowerCase()) {
    return fail(403, 'Cuenta fuera del dominio corporativo');
  }
  if (cfg.allowedEmails && cfg.allowedEmails.length && cfg.allowedEmails.indexOf(email) < 0) {
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
    return { label: label, value: sanitizeCell(f && f.value) };
  }).filter(function (f) { return f.label; });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildRxFields: buildRxFields, buildRxSchema: buildRxSchema, normalizeName: normalizeName,
    buildPhotoFileName: buildPhotoFileName, decodeJwtPayload: decodeJwtPayload,
    precheckClaims: precheckClaims, parseDataUrl: parseDataUrl, sanitizeCell: sanitizeCell,
    buildRow: buildRow, isValidUuid: isValidUuid, parseCsvList: parseCsvList, rateKey: rateKey,
    sanitizeExtraFields: sanitizeExtraFields, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES
  };
}
