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
  'Devolvé ÚNICAMENTE un objeto JSON válido con esta estructura exacta:',
  '{ "es_receta_optica": boolean, "campos": { <clave>: { "valor": string|null, "confianza": "alta"|"media"|"baja" } }, "anotaciones_extra": [{ "texto": string, "ubicacion": string, "confianza": "alta"|"media"|"baja" }] }.',
  'Convenciones: OD = ojo derecho; OI (u OS) = ojo izquierdo; ESF = esfera; CIL = cilindro; EJE en grados (0-180);',
  'ADD = adición; DIP/DP = distancia interpupilar (ej "62" o "31/31").',
  'Si un ojo tiene un solo número (ej "OD -2.00", "OI -1.50"), ese valor es ESFERA (cilindro y eje quedan en null).',
  'Normalizá dioptrías con signo explícito y 2 decimales con punto (ej "-1.75", "+0.50"). "Plano", "N", "neutro" o "pl" = "0.00".',
  'Eje: solo el número entero, sin "°".',
  'Si la receta no distingue lejos/cerca pero indica solo graduación de lejos (o una sola tabla sin "cerca"), usá los campos lejos_*; si indica "cerca" o "para leer", usá cerca_*; si solo indica ADD, completá "adicion" y dejá cerca_* en null.',
  'NO inventes: si un valor no está o es ilegible, valor = null y confianza = "baja".',
  'Confianza: "alta" si es claramente legible, "media" si hay dudas razonables, "baja" si es una conjetura.',
  'Todo texto, número, símbolo o garabato manuscrito que NO corresponda a un campo (notas, flechas, tachaduras con texto,',
  'indicaciones al óptico, teléfonos, firmas legibles, sellos) va en "anotaciones_extra" con su transcripción tentativa',
  'y ubicación aproximada (ej "margen superior derecho").',
  'Ignorá texto preimpreso del formulario salvo nombre/matrícula del médico.',
  'es_receta_optica = false si la imagen claramente no es una receta óptica.'
].join(' ');

function buildOcrPrompt_(fields) {
  var keys = fields.map(function (f) { return f.key; }).join(', ');
  return OCR_PROMPT + ' Claves exactas requeridas dentro de "campos": ' + keys + '.';
}

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
      case 'catalog': return json_(handleCatalog_(user));
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
  if (!c.clientId || (!c.domain && !c.allowedEmails.length)) throw httpError_(500, 'Backend sin configurar');

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

// ---------- Catálogo ----------

function ensureCatalogSheet_(ss) {
  var sheet = ss.getSheetByName('Catalogo');
  if (!sheet) {
    sheet = ss.insertSheet('Catalogo');
    var rows = [CATALOG_HEADERS].concat(SEED_CATALOG_ITEMS.map(catalogItemToRow));
    sheet.getRange(1, 1, rows.length, CATALOG_HEADERS.length).setValues(rows);
    sheet.getRange(1, 1, 1, CATALOG_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    var initRows = [CATALOG_HEADERS].concat(SEED_CATALOG_ITEMS.map(catalogItemToRow));
    sheet.getRange(1, 1, initRows.length, CATALOG_HEADERS.length).setValues(initRows);
    sheet.getRange(1, 1, 1, CATALOG_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleCatalog_(user) {
  var c = cfg_();
  if (!c.sheetId) throw httpError_(500, 'Falta SHEET_ID');
  var cache = CacheService.getScriptCache();
  var cached = cache.get('catalog_items');
  if (cached) return { ok: true, items: JSON.parse(cached) };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(c.sheetId);
    var catSheet = ensureCatalogSheet_(ss);
    var values = catSheet.getDataRange().getValues();
    var items = parseCatalogRows(values);
    cache.put('catalog_items', JSON.stringify(items), 300);
    return { ok: true, items: items };
  } finally { lock.releaseLock(); }
}

// ---------- OCR ----------

function handleOcr_(user, body) {
  var c = cfg_();
  if (!c.geminiKey) throw httpError_(500, 'Falta GEMINI_API_KEY');
  rateLimit_('ocr', user.email, c.rateOcr);
  var img = image_(body.image);
  var fields = rxFields_();

  var payload = JSON.stringify({
    contents: [{ parts: [{ text: buildOcrPrompt_(fields) }, { inline_data: { mime_type: img.mime, data: img.data } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });

  var models = [c.geminiModel, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
    .filter(function (m, i, arr) { return m && arr.indexOf(m) === i; });

  var res = null;
  var lastStatus = 500;
  for (var i = 0; i < models.length; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(models[i]) + ':generateContent';
    var attempt = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': c.geminiKey }, payload: payload
    });
    lastStatus = attempt.getResponseCode();
    if (lastStatus === 200) {
      res = attempt;
      break;
    }
    console.error('Gemini (' + models[i] + ') ' + lastStatus + ': ' + attempt.getContentText().slice(0, 400));
    if (lastStatus === 503 || lastStatus === 429 || lastStatus === 500 || lastStatus === 404) {
      if ((lastStatus === 503 || lastStatus === 429) && i < models.length - 1) Utilities.sleep(1200);
      continue;
    }
    throw httpError_(502, 'Falló el reconocimiento (' + lastStatus + ')');
  }
  if (!res) {
    if (lastStatus === 429 || lastStatus === 503) {
      throw httpError_(503, 'OCR temporalmente saturado (' + lastStatus + '). Reintentá en unos segundos.');
    }
    throw httpError_(502, 'Falló el reconocimiento (' + lastStatus + ')');
  }

  var data = JSON.parse(res.getContentText());
  var text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  if (!text) throw httpError_(502, 'El OCR no devolvió resultado');
  var cleaned = String(text).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  var parsed;
  try { parsed = JSON.parse(cleaned); } catch (e) { throw httpError_(502, 'Respuesta OCR ilegible'); }
  return { ok: true, fields: fields, rx: normalizeOcrResult(parsed, fields), raw: text };
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
      ['Corregido por usuario', body.corrected ? 'Sí' : 'No']
    );
    var q = body.quoteSummary && typeof body.quoteSummary === 'object' ? body.quoteSummary : null;
    if (q) {
      record.push(
        ['Uso anteojo', sanitizeCell(q.uso, 40)],
        ['Ojos cotizados', sanitizeCell(q.eyesMode, 40)],
        ['½ Par OD', sanitizeCell(q.odNombre, 140)],
        ['Tipo OD', sanitizeCell(q.odTipo, 30)],
        ['Precio ½ OD', sanitizeCell(q.odPrecio, 30)],
        ['½ Par OI', sanitizeCell(q.oiNombre, 140)],
        ['Tipo OI', sanitizeCell(q.oiTipo, 30)],
        ['Precio ½ OI', sanitizeCell(q.oiPrecio, 30)],
        ['Armazón', sanitizeCell(q.armazon, 140)],
        ['Precio Armazón', sanitizeCell(q.armazonPrecio, 30)],
        ['Descuento / OS', sanitizeCell(q.descuento, 80)],
        ['Seña', sanitizeCell(q.sena, 30)],
        ['Total Lista', sanitizeCell(q.totalLista, 30)],
        ['Total Efectivo (-10%)', sanitizeCell(q.totalEfectivo, 30)],
        ['Plan Cristalino', sanitizeCell(q.planCristalino, 300)]
      );
    }
    record.push(
      ['Foto', file.getUrl()],
      ['OCR crudo', sanitizeCell(body.raw, 45000)]
    );

    if (Array.isArray(body.newCatalogItems) && body.newCatalogItems.length) {
      var catSheet = ensureCatalogSheet_(ss);
      var addedCat = [];
      body.newCatalogItems.slice(0, 4).forEach(function (it, i) {
        var clean = sanitizeCatalogItem(it, stamp + '-' + (i + 1));
        if (clean) addedCat.push(catalogItemToRow(clean));
      });
      if (addedCat.length) {
        catSheet.getRange(catSheet.getLastRow() + 1, 1, addedCat.length, CATALOG_HEADERS.length).setValues(addedCat);
        cache.remove('catalog_items');
      }
    }

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
  out.push('ALLOWED_DOMAIN: ' + (c.domain || (c.allowedEmails.length ? '(no requerido: usa ALLOWED_EMAILS)' : 'FALTA (poné ALLOWED_DOMAIN o ALLOWED_EMAILS)')));
  out.push('ALLOWED_EMAILS: ' + (c.allowedEmails.length ? c.allowedEmails.length + ' usuarios' : (c.domain ? '(todo el dominio)' : 'FALTA')));
  try {
    var ss = SpreadsheetApp.openById(c.sheetId);
    out.push('Sheet: ' + ss.getName());
    var catSheet = ensureCatalogSheet_(ss);
    var catCount = parseCatalogRows(catSheet.getDataRange().getValues()).length;
    out.push('Catalogo: OK (' + catCount + ' productos activos)');
  } catch (e) { out.push('Sheet/Catalogo: ERROR ' + e.message); }
  try { out.push('Carpeta: ' + DriveApp.getFolderById(c.folderId).getName()); } catch (e) { out.push('Carpeta: ERROR ' + e.message); }
  try {
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + c.geminiModel,
      { headers: { 'x-goog-api-key': c.geminiKey }, muteHttpExceptions: true });
    out.push('Gemini (' + c.geminiModel + '): HTTP ' + r.getResponseCode());
  } catch (e) { out.push('Gemini: ERROR ' + e.message); }
  console.log(out.join('\n'));
  return out;
}
