/**
 * Code.gs — Backend Apps Script (Web App).
 * Requiere Logic.gs en el mismo proyecto.
 * Configuración: Script Properties (ver docs/SETUP.md).
 */

// Lazy: el orden de carga entre archivos .gs no está garantizado.
function rxFields_() { return buildRxFields(); }
var GLOBAL_FAIL_LIMIT = 200; // rechazos / 10 min antes de cortar validaciones remotas

var OCR_PROMPT = [
  'Sos un asistente experto en recetas ópticas argentinas manuscritas.',
  'Transcribí la receta de la imagen al JSON pedido.',
  'Convenciones: OD = ojo derecho; OI (u OS) = ojo izquierdo; ESF = esfera; CIL = cilindro; EJE en grados (0-180);',
  'ADD = adición; DIP/DP = distancia interpupilar (ej "62" o "31/31").',
  'Normalizá dioptrías con signo explícito y 2 decimales con punto (ej "-1.75", "+0.50"). "Plano", "N", "neutro" o "pl" = "0.00".',
  'Eje: solo el número entero, sin "°".',
  'Si la receta tiene una sola fila para cerca, usá los campos de cerca; si solo indica ADD, completá "adicion" y dejá cerca en null.',
  'NO inventes: si un valor no está o es ilegible, valor = null y confianza = "baja".',
  'Confianza: "alta" si es claramente legible, "media" si hay dudas razonables, "baja" si es una conjetura.',
  'Todo texto, número, símbolo o garabato manuscrito que NO corresponda a un campo (notas, flechas, tachaduras con texto,',
  'indicaciones al óptico, teléfonos, firmas legibles, sellos) va en "anotaciones_extra" con su transcripción tentativa',
  'y ubicación aproximada (ej "margen superior derecho").',
  'Ignorá texto preimpreso del formulario salvo nombre/matrícula del médico.',
  'es_receta_optica = false si la imagen claramente no es una receta óptica.'
].join(' ');

// ---------- Entradas HTTP ----------

function doGet() {
  return ContentService.createTextOutput('OK');
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var user = authenticate_(body.idToken);
    switch (body.action) {
      case 'ping': return json_({ ok: true, email: user.email });
      case 'ocr': return json_(handleOcr_(user, body));
      case 'save': return json_(handleSave_(user, body));
      default: throw httpError_(400, 'Acción desconocida');
    }
  } catch (err) {
    var code = err.code || 500;
    if (code === 401 || code === 403) countFail_();
    if (code === 500) console.error(err && err.stack || err);
    return json_({ ok: false, code: code, error: code === 500 ? 'Error interno' : err.message });
  }
}

// ---------- Config ----------

function cfg_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    geminiKey: p.GEMINI_API_KEY || '',
    geminiModel: p.GEMINI_MODEL || 'gemini-flash-latest',
    clientId: p.OAUTH_CLIENT_ID || '',
    domain: (p.ALLOWED_DOMAIN || '').trim().toLowerCase(),
    allowedEmails: parseCsvList(p.ALLOWED_EMAILS),
    sheetId: p.SHEET_ID || '',
    sheetName: p.SHEET_NAME || '',
    folderId: p.DRIVE_FOLDER_ID || '',
    tz: p.TIMEZONE || TZ_DEFAULT,
    rateOcr: Number(p.RATE_OCR_PER_HOUR || 30),
    rateSave: Number(p.RATE_SAVE_PER_HOUR || 30)
  };
}

// ---------- Seguridad ----------

function authenticate_(token) {
  if (!token || String(token).length > 4096) throw httpError_(401, 'Iniciá sesión con tu cuenta corporativa');
  var c = cfg_();
  if (!c.clientId || !c.domain) throw httpError_(500, 'Backend sin configurar');

  // 1) Pre-chequeo local (gratis): descarta basura sin gastar UrlFetch.
  var claims;
  try {
    claims = decodeJwtPayload(token, function (s) {
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString();
    });
  } catch (e) { throw httpError_(401, 'Token inválido'); }
  var now = Math.floor(Date.now() / 1000);
  var pre = precheckClaims(claims, c, now);
  if (!pre.ok) throw httpError_(pre.code, pre.reason);

  // 2) Caché de tokens ya verificados.
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + sha256_(token);
  if (cache.get(key)) return { email: pre.email };

  // 3) Freno global ante bombardeo.
  if (failCount_() > GLOBAL_FAIL_LIMIT) throw httpError_(429, 'Demasiados intentos. Probá en unos minutos.');

  // 4) Verificación de firma por Google.
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw httpError_(401, 'Token rechazado por Google');
  var verified = precheckClaims(JSON.parse(res.getContentText()), c, now);
  if (!verified.ok) throw httpError_(verified.code, verified.reason);

  var ttl = Math.min(600, Number(claims.exp) - now);
  if (ttl > 30) cache.put(key, '1', ttl);
  return { email: verified.email };
}

function rateLimit_(action, email, limit) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var key = rateKey(action, email, Date.now());
    var n = Number(cache.get(key) || 0) + 1;
    if (n > limit) throw httpError_(429, 'Límite por hora alcanzado (' + limit + '). Probá más tarde.');
    cache.put(key, String(n), 3600);
  } finally { lock.releaseLock(); }
}

function failKey_() { return 'fail_' + Math.floor(Date.now() / 600000); }
function failCount_() { return Number(CacheService.getScriptCache().get(failKey_()) || 0); }
function countFail_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.put(failKey_(), String(failCount_() + 1), 600);
  } catch (e) { /* no bloquear respuesta */ }
}

// ---------- OCR ----------

function handleOcr_(user, body) {
  var c = cfg_();
  if (!c.geminiKey) throw httpError_(500, 'Falta GEMINI_API_KEY');
  rateLimit_('ocr', user.email, c.rateOcr);
  var img = image_(body.image);

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(c.geminiModel) + ':generateContent';
  var payload = {
    contents: [{ parts: [{ text: OCR_PROMPT }, { inline_data: { mime_type: img.mime, data: img.data } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: buildRxSchema(rxFields_()) }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': c.geminiKey }, payload: JSON.stringify(payload)
  });
  var status = res.getResponseCode();
  if (status === 429) throw httpError_(503, 'OCR saturado. Reintentá en un minuto.');
  if (status !== 200) {
    console.error('Gemini ' + status + ': ' + res.getContentText().slice(0, 500));
    throw httpError_(502, 'Falló el reconocimiento (' + status + ')');
  }
  var data = JSON.parse(res.getContentText());
  var text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  if (!text) throw httpError_(502, 'El OCR no devolvió resultado');
  var rx;
  try { rx = JSON.parse(text); } catch (e) { throw httpError_(502, 'Respuesta OCR ilegible'); }
  return { ok: true, fields: rxFields_(), rx: rx, raw: text };
}

// ---------- Guardado ----------

function handleSave_(user, body) {
  var c = cfg_();
  if (!c.sheetId || !c.folderId) throw httpError_(500, 'Falta SHEET_ID o DRIVE_FOLDER_ID');
  if (!isValidUuid(body.uuid)) throw httpError_(400, 'ID de envío inválido');
  var name = sanitizeCell(body.photoName, 80);
  if (!name) throw httpError_(400, 'Falta el nombre');
  var img = image_(body.image);

  var cache = CacheService.getScriptCache();
  var doneKey = 'saved_' + body.uuid;
  var prev = cache.get(doneKey);
  if (prev) return JSON.parse(prev);

  rateLimit_('save', user.email, c.rateSave);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(c.sheetId);
    var sheet = c.sheetName ? ss.getSheetByName(c.sheetName) : ss.getSheets()[0];
    if (!sheet) throw httpError_(500, 'Hoja no encontrada');

    // Idempotencia ante caché vencida: buscar UUID en la hoja.
    var found = sheet.createTextFinder(body.uuid).matchEntireCell(true).findNext();
    if (found) return { ok: true, duplicate: true, fila: found.getRow(), fotoUrl: '' };

    var now = new Date();
    var stamp = Utilities.formatDate(now, c.tz, 'yyyy-MM-dd_HHmmss');
    var fileName = buildPhotoFileName(stamp, name, img.mime);
    var blob = Utilities.newBlob(Utilities.base64Decode(img.data), img.mime, fileName);
    var file = DriveApp.getFolderById(c.folderId).createFile(blob);
    file.setDescription('Subida por ' + user.email + ' · ' + body.uuid);

    var rx = body.rx && typeof body.rx === 'object' ? body.rx : {};
    var record = [
      ['Timestamp', Utilities.formatDate(now, c.tz, 'yyyy-MM-dd HH:mm:ss')],
      ['UUID', body.uuid],
      ['Usuario', user.email]
    ];
    sanitizeExtraFields(body.extraFields).forEach(function (f) { record.push([f.label, f.value]); });
    rxFields_().forEach(function (f) { record.push([f.label, sanitizeCell(rx[f.key])]); });
    var extras = Array.isArray(body.extras) ? body.extras.slice(0, 30).map(function (x) { return sanitizeCell(x, 300); }) : [];
    record.push(
      ['Anotaciones extra', sanitizeCell(extras.filter(Boolean).join('; '), 5000)],
      ['Es receta (IA)', body.isRx === false ? 'No' : 'Sí'],
      ['Corregido por usuario', body.corrected ? 'Sí' : 'No'],
      ['Foto', file.getUrl()],
      ['OCR crudo', sanitizeCell(body.raw, 45000)]
    );

    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var existing = sheet.getLastRow() ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    var built = buildRow(existing, record);
    if (built.added.length) {
      sheet.getRange(1, 1, 1, built.headers.length).setValues([built.headers]).setFontWeight('bold');
      if (!sheet.getFrozenRows()) sheet.setFrozenRows(1);
    }
    var rowIdx = sheet.getLastRow() + 1;
    var range = sheet.getRange(rowIdx, 1, 1, built.row.length);
    range.setNumberFormat('@'); // texto plano: conserva "+0.50", "031", etc.
    range.setValues([built.row]);

    var result = { ok: true, fila: rowIdx, fotoUrl: file.getUrl(), fotoNombre: fileName };
    cache.put(doneKey, JSON.stringify(result), 21600);
    return result;
  } finally { lock.releaseLock(); }
}

// ---------- Utilidades ----------

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) throw httpError_(400, 'Cuerpo vacío');
  if (raw.length > 7 * 1024 * 1024) throw httpError_(413, 'Envío demasiado grande');
  try { return JSON.parse(raw); } catch (err) { throw httpError_(400, 'JSON inválido'); }
}

function image_(dataUrl) {
  try { return parseDataUrl(dataUrl); } catch (e) { throw httpError_(400, e.message); }
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function httpError_(code, msg) { var e = new Error(msg); e.code = code; return e; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Diagnóstico (ejecutar a mano desde el editor) ----------

/** Verifica configuración, autoriza permisos y prueba la API key. Ver logs. */
function setupCheck() {
  var c = cfg_();
  var out = [];
  out.push('OAUTH_CLIENT_ID: ' + (c.clientId ? 'OK' : 'FALTA'));
  out.push('ALLOWED_DOMAIN: ' + (c.domain || 'FALTA'));
  out.push('ALLOWED_EMAILS: ' + (c.allowedEmails.length ? c.allowedEmails.length + ' usuarios' : '(todo el dominio)'));
  try { out.push('Sheet: ' + SpreadsheetApp.openById(c.sheetId).getName()); } catch (e) { out.push('Sheet: ERROR ' + e.message); }
  try { out.push('Carpeta: ' + DriveApp.getFolderById(c.folderId).getName()); } catch (e) { out.push('Carpeta: ERROR ' + e.message); }
  try {
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + c.geminiModel,
      { headers: { 'x-goog-api-key': c.geminiKey }, muteHttpExceptions: true });
    out.push('Gemini (' + c.geminiModel + '): HTTP ' + r.getResponseCode());
  } catch (e) { out.push('Gemini: ERROR ' + e.message); }
  console.log(out.join('\n'));
  return out;
}
