/**
 * Code.gs — Backend Apps Script (Web App).
 * Requiere Logic.gs en el mismo proyecto.
 * Configuración: Script Properties (ver docs/SETUP.md).
 */

// Lazy: el orden de carga entre archivos .gs no está garantizado.
function rxFields_() { return buildRxFields(); }
var GLOBAL_FAIL_LIMIT = 200; // rechazos / 10 min antes de cortar validaciones remotas

var OCR_PROMPT = [
  'Sos un asistente experto en recetas ópticas argentinas (manuscritas, impresas/electrónicas o mixtas).',
  'Devolvé ÚNICAMENTE un objeto JSON válido con esta estructura exacta:',
  '{ "es_receta_optica": boolean, "campos": { <clave>: { "valor": string|null, "confianza": "alta"|"media"|"baja" } }, "anotaciones_extra": [{ "texto": string, "ubicacion": string, "confianza": "alta"|"media"|"baja" }] }.',
  'Convenciones: OD = ojo derecho; OI (u OS) = ojo izquierdo; ESF = esfera; CIL = cilindro; EJE en grados (0-180);',
  'ADD = adición; DIP/DP = distancia interpupilar (ej "62" o "31/31").',
  'Si un ojo tiene un solo número (ej "OD -2.00", "OI -1.50"), ese valor es ESFERA (cilindro y eje quedan en null).',
  'Normalizá dioptrías con signo explícito y 2 decimales con punto (ej "-1.75", "+0.50"). "Plano", "N", "neutro" o "pl" = "0.00".',
  'Eje: solo el número entero, sin "°".',
  'Si la receta no distingue lejos/cerca pero indica solo graduación de lejos (o una sola tabla sin "cerca"), usá los campos lejos_*; si indica "cerca" o "para leer", usá cerca_*; si solo indica ADD, completá "adicion" y dejá cerca_* en null.',
  'NO inventes: si un valor no está, es ilegible o está tapado/censurado con un rectángulo o tachadura, devolvé valor = null y confianza = "baja".',
  'Confianza: "alta" si es claramente legible, "media" si hay dudas razonables, "baja" si es una conjetura.',
  'Todo texto o indicación relevante para el óptico que NO corresponda a un campo (notas, flechas,',
  'tratamientos pedidos, teléfonos, sellos legibles) va en "anotaciones_extra" (máximo 5 items) con su transcripción tentativa',
  'y ubicación aproximada (ej "margen inferior derecho").',
  'Ignorá códigos QR, códigos de barras, números administrativos/afiliado del formulario y textos legales del membrete.',
  'En "dni", extraé solo los números del DNI/documento del paciente si figura (sin puntos ni espacios); si no está o está tapado, null.',
  'En "paciente" y "medico", formateá SIEMPRE como "Apellido Nombre" (primero apellido y luego nombre, en formato Título, sin comas ni prefijos Dr./Dra.).',
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
      case 'search': return json_(handleSearch_(user, body));
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
    rateSave: Number(p.RATE_SAVE_PER_HOUR || 120)
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

// ---------- Catálogo y Medios de Pago ----------

function ensureConfigSheet_(ss, name, headers, seedRows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    var rows = [headers].concat(seedRows);
    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  return sheet;
}

function ensureCatalogSheet_(ss) {
  return ensureConfigSheet_(ss, 'Catalogo', CATALOG_HEADERS, SEED_CATALOG_ITEMS.map(catalogItemToRow));
}

function ensurePaymentSheet_(ss) {
  return ensureConfigSheet_(ss, 'Medios_Pago', PAYMENT_HEADERS, SEED_PAYMENT_ROWS);
}

function handleCatalog_(user) {
  var c = cfg_();
  if (!c.sheetId) throw httpError_(500, 'Falta SHEET_ID');
  var cache = CacheService.getScriptCache();
  var cached = cache.get('catalog_bundle');
  if (cached) return JSON.parse(cached);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(c.sheetId);
    var catSheet = ensureCatalogSheet_(ss);
    var paySheet = ensurePaymentSheet_(ss);
    var items = parseCatalogRows(catSheet.getDataRange().getValues());
    var paymentConfig = parsePaymentRows(paySheet.getDataRange().getValues());
    var out = { ok: true, items: items, paymentConfig: paymentConfig };
    cache.put('catalog_bundle', JSON.stringify(out), 300);
    return out;
  } finally { lock.releaseLock(); }
}

// ---------- OCR ----------

function ocrModelCandidates_(c, cachedModel) {
  var explicit = (c.geminiModel && c.geminiModel !== 'gemini-flash-latest') ? c.geminiModel : '';
  return [
    cachedModel,
    explicit,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-flash-lite-latest',
    'gemini-flash-latest'
  ].filter(function (m, i, arr) { return m && arr.indexOf(m) === i; });
}

function fetchGeminiModel_(model, contents, maxTokensOverride, apiKey, cache) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  var cachedMode = cache ? cache.get('think_mode_' + model) : '';
  var modes = thinkingModesForModel(model, cachedMode);
  var lastAttempt = null;
  var lastMode = modes[0];
  for (var j = 0; j < modes.length; j++) {
    var mode = modes[j];
    lastMode = mode;
    var payload = JSON.stringify({
      contents: contents,
      generationConfig: buildOcrGenerationConfig(mode, maxTokensOverride)
    });
    try {
      var attempt = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: { 'x-goog-api-key': apiKey },
        payload: payload
      });
    } catch (fetchErr) {
      return { attempt: null, mode: mode, fetchError: String((fetchErr && fetchErr.message) || fetchErr) };
    }
    lastAttempt = attempt;
    var code = attempt.getResponseCode();
    if (code === 400 && j < modes.length - 1) {
      if (cache && mode === cachedMode) cache.remove('think_mode_' + model);
      continue;
    }
    if (code === 200 && cache) {
      cache.put('think_mode_' + model, mode, 21600);
    }
    return { attempt: attempt, mode: mode, fetchError: '' };
  }
  return { attempt: lastAttempt, mode: lastMode, fetchError: '' };
}

function handleOcr_(user, body) {
  var c = cfg_();
  if (!c.geminiKey) throw httpError_(500, 'Falta GEMINI_API_KEY');
  rateLimit_('ocr', user.email, c.rateOcr);
  var img = image_(body.image);
  var fields = rxFields_();

  var baseContents = [{ parts: [{ text: buildOcrPrompt_(fields) }, { inline_data: { mime_type: img.mime, data: img.data } }] }];

  var cache = CacheService.getScriptCache();
  var cachedModel = cache.get('ocr_ok_model');
  var models = ocrModelCandidates_(c, cachedModel);

  var lastStatus = 0;
  var lastDetail = '';
  var tried = [];
  var started = Date.now();
  for (var i = 0; i < models.length; i++) {
    if (i > 0 && Date.now() - started > 45000) break;
    var model = models[i];
    var t0 = Date.now();
    var callRes = fetchGeminiModel_(model, baseContents, 0, c.geminiKey, cache);
    var sec = Math.round((Date.now() - t0) / 1000);
    if (callRes.fetchError || !callRes.attempt) {
      if (i === 0 && cachedModel) cache.remove('ocr_ok_model');
      console.error('Gemini (' + model + ') fetch error in ' + sec + 's: ' + callRes.fetchError);
      tried.push(model + ':timeout(' + sec + 's)');
      lastStatus = 504;
      lastDetail = 'Timeout en Gemini';
      continue;
    }
    var attempt = callRes.attempt;
    var status = attempt.getResponseCode();
    if (status === 200) {
      var bodyData = null;
      try { bodyData = JSON.parse(attempt.getContentText()); } catch (e) { bodyData = null; }
      var extracted = extractOcrJson(bodyData);
      if (extracted.ok) {
        cache.put('ocr_ok_model', model, 1800);
        return {
          ok: true, fields: fields, rx: normalizeOcrResult(extracted.parsed, fields),
          raw: extracted.raw, model: model, thinkMode: callRes.mode
        };
      }
      if (i === 0 && cachedModel) cache.remove('ocr_ok_model');
      console.error('Gemini (' + model + ') bad OCR JSON (' + extracted.reason + ', finish=' + extracted.finishReason + ') in ' + sec + 's: ' + extracted.raw);
      tried.push(model + ':' + extracted.reason + '(' + (extracted.finishReason || '200') + ',' + sec + 's)');
      lastStatus = 200;
      lastDetail = extracted.reason + (extracted.finishReason ? ' (' + extracted.finishReason + ')' : '');
      continue;
    }
    if (i === 0 && cachedModel) cache.remove('ocr_ok_model');
    var snippet = attempt.getContentText().slice(0, 300);
    console.error('Gemini (' + model + ') ' + status + ' in ' + sec + 's: ' + snippet);
    tried.push(model + ':' + status + '(' + sec + 's)');
    if (status !== 404 || !lastStatus) {
      lastStatus = status;
      try {
        var errJson = JSON.parse(attempt.getContentText());
        if (errJson && errJson.error && errJson.error.message) lastDetail = errJson.error.message;
      } catch (e) { /* noop */ }
    }
    if (status === 400 || status === 404 || status === 429 || status === 500 || status === 503) {
      if ((status === 503 || status === 429) && i < models.length - 1 && Date.now() - started < 40000) Utilities.sleep(800);
      continue;
    }
    throw httpError_(502, 'Falló el reconocimiento (' + status + (lastDetail ? ': ' + lastDetail : '') + ')');
  }
  var info = tried.join(', ') + (lastDetail ? ' — ' + lastDetail : '');
  if (lastStatus === 504 || lastStatus === 429 || lastStatus === 503) {
    throw httpError_(503, 'OCR temporalmente saturado o lento [' + info + ']. Reintentá en unos segundos.');
  }
  throw httpError_(502, 'Falló el reconocimiento [' + info + ']');
}

// ---------- Guardado ----------

function extractDriveId_(url) {
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url || '')) || /[?&]id=([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

function findUuidRowIndices_(sheet, uuid) {
  if (!uuid || sheet.getLastRow() < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var uuidCol = headers.indexOf('UUID');
  var matches = sheet.createTextFinder(String(uuid)).matchEntireCell(true).findAll();
  var seen = {};
  var rows = [];
  matches.forEach(function (cell) {
    var r = cell.getRow();
    if (r < 2) return;
    if (uuidCol >= 0 && cell.getColumn() !== uuidCol + 1) return;
    if (!seen[r]) { seen[r] = true; rows.push(r); }
  });
  rows.sort(function (a, b) { return a - b; });
  return rows;
}

function writeRowWithHeaders_(sheet, targetRow, existingHeaders, record, baseRow) {
  var built = buildRow(existingHeaders, record, baseRow);
  if (built.added.length) {
    sheet.getRange(1, 1, 1, built.headers.length).setValues([built.headers]).setFontWeight('bold');
    if (!sheet.getFrozenRows()) sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  var range = sheet.getRange(targetRow, 1, 1, built.row.length);
  range.setNumberFormat('General');
  range.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  range.setValues([built.row]);
  return built.headers;
}

function buildBaseRecord_(user, body, extraFields, fotoUrl, nowStr, statusLabel, includeTimestamp) {
  var record = [];
  if (includeTimestamp) record.push(['Timestamp', nowStr]);
  record.push(
    ['Última actualización', nowStr],
    ['UUID', body.uuid],
    ['Usuario', user.email],
    ['Estado', statusLabel]
  );

  if (Array.isArray(extraFields) && extraFields.length) {
    extraFields.forEach(function (f) { record.push([f.label, f.value]); });
  }
  if (body.rx && typeof body.rx === 'object') {
    var rx = body.rx;
    rxFields_().forEach(function (f) {
      var v = toSheetValue(rx[f.key]);
      if (f.key === 'paciente' && typeof v === 'string' && v) v = formatPersonName(v);
      record.push([f.label, v]);
    });
    var extras = Array.isArray(body.extras) ? body.extras.slice(0, 30).map(function (x) { return sanitizeCell(x, 300); }) : [];
    record.push(
      ['Anotaciones extra', sanitizeCell(extras.filter(Boolean).join('; '), 5000)],
      ['Es receta (IA)', body.isRx === false ? 'No' : 'Sí'],
      ['Corregido por usuario', body.corrected ? 'Sí' : 'No']
    );
  }

  var cData = body.closure && typeof body.closure === 'object' ? body.closure : null;
  if (cData) {
    record.push(
      ['Venta concretada', cData.sold === true ? 'Sí' : (cData.sold === false ? 'No' : '')],
      ['Número OT', sanitizeCell(cData.ot, 60)],
      ['Monto Venta', cData.monto !== '' && cData.monto != null ? toSheetValue(cData.monto, 30) : ''],
      ['Tipo Lente Vendido', sanitizeCell(cData.tipoLente, 120)],
      ['Motivo No Venta / Abandono', sanitizeCell(cData.motivo, 500)]
    );
  }

  var tm = body.timings && typeof body.timings === 'object' ? body.timings : null;
  if (tm) {
    record.push(
      ['Inicio Captura', sanitizeCell(tm.inicioIso, 40)],
      ['Seg Paso 1 (OCR)', tm.paso1Sec != null ? toSheetValue(tm.paso1Sec, 20) : ''],
      ['Seg Paso 2 (Revisión)', tm.paso2Sec != null ? toSheetValue(tm.paso2Sec, 20) : ''],
      ['Seg Paso 3 (Datos)', tm.paso3Sec != null ? toSheetValue(tm.paso3Sec, 20) : ''],
      ['Seg Paso 4 (Presupuesto)', tm.paso4Sec != null ? toSheetValue(tm.paso4Sec, 20) : ''],
      ['Seg Cierre', tm.cierreSec != null ? toSheetValue(tm.cierreSec, 20) : ''],
      ['Seg Totales', tm.totalSec != null ? toSheetValue(tm.totalSec, 20) : '']
    );
  }

  record.push(['Foto', fotoUrl]);
  if (body.originUuid && isValidUuid(body.originUuid) && body.originUuid !== body.uuid) {
    record.push(['Presupuesto Origen UUID', sanitizeCell(body.originUuid, 40)]);
  }
  return record;
}

function handleSearch_(user, body) {
  var c = cfg_();
  if (!c.sheetId) throw httpError_(500, 'Falta SHEET_ID');
  rateLimit_('search', user.email, 120);
  var query = String((body && body.query) || '').trim();
  if (query.length < 2) return { ok: true, results: [] };

  var ss = SpreadsheetApp.openById(c.sheetId);
  var sheet = c.sheetName ? ss.getSheetByName(c.sheetName) : ss.getSheets()[0];
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, results: [] };

  var rawRows = sheet.getDataRange().getValues().map(function (row, idx) {
    return row.map(function (cell) {
      if (idx > 0 && cell instanceof Date) {
        return Utilities.formatDate(cell, c.tz, 'yyyy-MM-dd HH:mm:ss');
      }
      return cell;
    });
  });
  return { ok: true, results: searchBudgetsInSheetRows(rawRows, query) };
}

function pushQuoteRecordFields_(record, q, idx) {
  record.push(
    ['Opción #', toSheetValue(q.opcion || (idx + 1), 10)],
    ['Uso anteojo', sanitizeCell(q.uso, 40)],
    ['Ojos cotizados', sanitizeCell(q.eyesMode, 40)],
    ['½ Par OD', sanitizeCell(q.odNombre, 140)],
    ['Tipo OD', sanitizeCell(q.odTipo, 30)],
    ['Precio ½ OD', toSheetValue(q.odPrecio, 30)],
    ['½ Par OI', sanitizeCell(q.oiNombre, 140)],
    ['Tipo OI', sanitizeCell(q.oiTipo, 30)],
    ['Precio ½ OI', toSheetValue(q.oiPrecio, 30)],
    ['Armazón', sanitizeCell(q.armazon, 140)],
    ['Precio Armazón', toSheetValue(q.armazonPrecio, 30)],
    ['Descuento / OS', toSheetValue(q.descuento, 80)],
    ['Seña', toSheetValue(q.sena, 30)],
    ['Total Lista', toSheetValue(q.totalLista, 30)],
    ['Total Efectivo (-10%)', toSheetValue(q.totalEfectivo, 30)],
    ['Plan Cristalino', sanitizeCell(q.planCristalino, 300)]
  );
}

function handleSave_(user, body) {
  var c = cfg_();
  if (!c.sheetId || !c.folderId) throw httpError_(500, 'Falta SHEET_ID o DRIVE_FOLDER_ID');
  if (!isValidUuid(body.uuid)) throw httpError_(400, 'ID de envío inválido');
  var stage = String(body.stage || 'presupuestado').toLowerCase();
  var name = sanitizeCell(body.photoName, 80) || 'Pendiente';
  var img = body.image ? image_(body.image) : null;

  var cache = CacheService.getScriptCache();
  rateLimit_('save', user.email, c.rateSave);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(c.sheetId);
    var sheet = c.sheetName ? ss.getSheetByName(c.sheetName) : ss.getSheets()[0];
    if (!sheet) throw httpError_(500, 'Hoja no encontrada');

    var now = new Date();
    var nowStr = Utilities.formatDate(now, c.tz, 'yyyy-MM-dd HH:mm:ss');
    var stamp = Utilities.formatDate(now, c.tz, 'yyyy-MM-dd_HHmmss');

    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var existingHeaders = sheet.getLastRow() ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    var foundRows = findUuidRowIndices_(sheet, body.uuid);
    var found = foundRows.length > 0;
    var existingRow0 = found ? sheet.getRange(foundRows[0], 1, 1, lastCol).getValues()[0] : [];

    var fotoCol = existingHeaders.indexOf('Foto');
    var bodyFotoUrl = (typeof body.fotoUrl === 'string' && /^https:\/\/drive\.google\.com\//i.test(body.fotoUrl.trim()))
      ? body.fotoUrl.trim() : '';
    var fotoUrl = (found && fotoCol >= 0 && existingRow0[fotoCol])
      ? String(existingRow0[fotoCol]) : bodyFotoUrl;
    var fileName = '';

    if (!fotoUrl) {
      if (!img) {
        if (body.isReflotado || stage === 'abandonado' || stage === 'anulado') {
          fotoUrl = '';
        } else {
          throw httpError_(400, 'Falta la imagen');
        }
      } else {
        fileName = buildPhotoFileName(stamp, name, img.mime);
        var blob = Utilities.newBlob(Utilities.base64Decode(img.data), img.mime, fileName);
        var file = DriveApp.getFolderById(c.folderId).createFile(blob);
        file.setDescription('Subida por ' + user.email + ' · ' + body.uuid);
        fotoUrl = file.getUrl();
      }
    } else if (name && name !== 'Pendiente') {
      try {
        var drvId = extractDriveId_(fotoUrl);
        if (drvId) {
          var drvFile = DriveApp.getFileById(drvId);
          var curName = drvFile.getName();
          if (/_(Pendiente|sin-nombre)\.(jpg|png)$/i.test(curName)) {
            fileName = curName.replace(/_(Pendiente|sin-nombre)\.(jpg|png)$/i, '_' + normalizeName(name) + '.$2');
            drvFile.setName(fileName);
          } else {
            fileName = curName;
          }
        }
      } catch (e) { /* conservar URL si no se pudo renombrar */ }
    }

    var cData = body.closure && typeof body.closure === 'object' ? body.closure : null;
    var statusLabel = 'PRESUPUESTADO';
    if (stage === 'incompleto') statusLabel = 'INCOMPLETO';
    else if (stage === 'abandonado') statusLabel = 'ABANDONADO';
    else if (stage === 'anulado') statusLabel = 'ANULADO';
    else if (stage === 'cerrado') statusLabel = (cData && cData.sold) ? 'VENTA CONCRETADA' : 'NO CONCRETADA';

    // Sincronizar Nombre cliente <-> Paciente y DNI <-> DNI paciente si uno falta.
    var extraFields = Array.isArray(body.extraFields) ? sanitizeExtraFields(body.extraFields) : [];
    var extraNameObj = null;
    var extraDniObj = null;
    for (var ei = 0; ei < extraFields.length; ei++) {
      if (extraFields[ei].label === 'Nombre cliente') extraNameObj = extraFields[ei];
      if (extraFields[ei].label === 'DNI') extraDniObj = extraFields[ei];
    }
    var rxPaciente = (body.rx && body.rx.paciente) ? formatPersonName(body.rx.paciente) : '';
    var resolvedPersonName = (extraNameObj && extraNameObj.value) || rxPaciente || (name !== 'Pendiente' ? formatPersonName(name) : '');
    if (resolvedPersonName) {
      if (extraNameObj) {
        if (!extraNameObj.value) extraNameObj.value = resolvedPersonName;
      } else {
        extraFields.unshift({ label: 'Nombre cliente', value: resolvedPersonName });
      }
      if (body.rx && typeof body.rx === 'object' && !body.rx.paciente) {
        body.rx.paciente = resolvedPersonName;
      }
    }
    var rxDniDigits = (body.rx && body.rx.dni) ? String(body.rx.dni).replace(/\D+/g, '') : '';
    var resolvedDni = (extraDniObj && extraDniObj.value !== '' ? String(extraDniObj.value).replace(/\D+/g, '') : '') || rxDniDigits;
    if (resolvedDni) {
      var dniSheetVal = toSheetValue(resolvedDni, 20);
      if (extraDniObj) {
        if (!extraDniObj.value) extraDniObj.value = dniSheetVal;
      } else {
        extraFields.push({ label: 'DNI', value: dniSheetVal });
      }
      if (body.rx && typeof body.rx === 'object' && !body.rx.dni) {
        body.rx.dni = resolvedDni;
      }
    }

    if (Array.isArray(body.newCatalogItems) && body.newCatalogItems.length) {
      var catSheet = ensureCatalogSheet_(ss);
      var addedCat = [];
      body.newCatalogItems.slice(0, 8).forEach(function (it, i) {
        var clean = sanitizeCatalogItem(it, stamp + '-' + (i + 1));
        if (clean) addedCat.push(catalogItemToRow(clean));
      });
      if (addedCat.length) {
        catSheet.getRange(catSheet.getLastRow() + 1, 1, addedCat.length, CATALOG_HEADERS.length).setValues(addedCat);
        cache.remove('catalog_bundle');
      }
    }

    var quoteList = (Array.isArray(body.quoteItems) && body.quoteItems.length)
      ? body.quoteItems
      : (body.quoteSummary && typeof body.quoteSummary === 'object' ? [body.quoteSummary] : []);
    var writtenRows = [];

    if (quoteList.length > 0) {
      for (var qi = 0; qi < quoteList.length; qi++) {
        var rowRecord = buildBaseRecord_(user, body, extraFields, fotoUrl, nowStr, statusLabel, !found);
        pushQuoteRecordFields_(rowRecord, quoteList[qi], qi);
        var isExisting = qi < foundRows.length;
        var targetRow = isExisting ? foundRows[qi] : (Math.max(sheet.getLastRow(), 1) + 1);
        var baseRow = isExisting
          ? sheet.getRange(targetRow, 1, 1, Math.max(sheet.getLastColumn(), existingHeaders.length, 1)).getValues()[0]
          : existingRow0;
        existingHeaders = writeRowWithHeaders_(sheet, targetRow, existingHeaders, rowRecord, baseRow);
        writtenRows.push(targetRow);
      }
      if (foundRows.length > quoteList.length) {
        for (var delIdx = foundRows.length - 1; delIdx >= quoteList.length; delIdx--) {
          sheet.deleteRow(foundRows[delIdx]);
        }
      }
    } else if (found) {
      for (var fi = 0; fi < foundRows.length; fi++) {
        var rIdx = foundRows[fi];
        var curRow = sheet.getRange(rIdx, 1, 1, Math.max(sheet.getLastColumn(), existingHeaders.length, 1)).getValues()[0];
        var updRecord = buildBaseRecord_(user, body, extraFields, fotoUrl, nowStr, statusLabel, false);
        existingHeaders = writeRowWithHeaders_(sheet, rIdx, existingHeaders, updRecord, curRow);
        writtenRows.push(rIdx);
      }
    } else {
      var newRowNum = Math.max(sheet.getLastRow(), 1) + 1;
      var insRecord = buildBaseRecord_(user, body, extraFields, fotoUrl, nowStr, statusLabel, true);
      existingHeaders = writeRowWithHeaders_(sheet, newRowNum, existingHeaders, insRecord, []);
      writtenRows.push(newRowNum);
    }

    return {
      ok: true,
      fila: writtenRows[0] || 0,
      filas: writtenRows,
      fotoUrl: fotoUrl,
      fotoNombre: fileName,
      estado: statusLabel,
      updated: Boolean(found)
    };
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

/** Migra encabezados renombrados y elimina columnas obsoletas en la hoja principal. */
function cleanupMainSheetColumns_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h || '').trim(); });
  var actions = [];
  var colsToDelete = [];

  function mergeOrRename(srcName, dstName) {
    var srcIdx = headers.indexOf(srcName);
    if (srcIdx < 0) return;
    var dstIdx = headers.indexOf(dstName);
    if (dstIdx >= 0 && dstIdx !== srcIdx) {
      if (lastRow > 1) {
        var colOut = [];
        for (var r = 0; r < lastRow; r++) {
          var dstVal = values[r][dstIdx];
          var srcVal = values[r][srcIdx];
          if (r > 0 && (dstVal === '' || dstVal == null) && srcVal !== '' && srcVal != null) {
            values[r][dstIdx] = srcVal;
          }
          colOut.push([values[r][dstIdx]]);
        }
        sheet.getRange(1, dstIdx + 1, lastRow, 1).setValues(colOut);
      }
      if (colsToDelete.indexOf(srcIdx) < 0) colsToDelete.push(srcIdx);
      actions.push(srcName + ' -> ' + dstName + ' (fusionada)');
    } else {
      headers[srcIdx] = dstName;
      values[0][srcIdx] = dstName;
      sheet.getRange(1, srcIdx + 1).setValue(dstName);
      actions.push(srcName + ' -> ' + dstName + ' (renombrada)');
    }
  }

  mergeOrRename('Apellido y Nombre cliente', 'Nombre cliente');
  mergeOrRename('Nombre', 'Nombre Recomendador');

  ['¿De dónde nos conoce?', 'Quién', 'Cuál', 'Quién / Cuál', 'OCR Crudo'].forEach(function (obsolete) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] === obsolete && colsToDelete.indexOf(i) < 0) {
        colsToDelete.push(i);
        actions.push('Eliminada: ' + obsolete);
      }
    }
  });

  colsToDelete.sort(function (a, b) { return b - a; }).forEach(function (colIdx) {
    sheet.deleteColumn(colIdx + 1);
  });
  return actions;
}

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
    var mainSheet = c.sheetName ? ss.getSheetByName(c.sheetName) : ss.getSheets()[0];
    if (mainSheet) {
      var cleaned = cleanupMainSheetColumns_(mainSheet);
      out.push('Columnas limpiadas: ' + (cleaned.length ? cleaned.join(', ') : '(sin cambios)'));
    }
    var catSheet = ensureCatalogSheet_(ss);
    var catCount = parseCatalogRows(catSheet.getDataRange().getValues()).length;
    out.push('Catalogo: OK (' + catCount + ' productos activos)');
    var paySheet = ensurePaymentSheet_(ss);
    var payCfg = parsePaymentRows(paySheet.getDataRange().getValues());
    out.push('Medios_Pago: OK (' + payCfg.cardPlans.length + ' planes tarjeta, ' + payCfg.cristalinoPlans.length + ' planes Cristalino)');
  } catch (e) { out.push('Sheet/Catalogo: ERROR ' + e.message); }
  try { out.push('Carpeta: ' + DriveApp.getFolderById(c.folderId).getName()); } catch (e) { out.push('Carpeta: ERROR ' + e.message); }
  try {
    var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + c.geminiModel,
      { headers: { 'x-goog-api-key': c.geminiKey }, muteHttpExceptions: true });
    out.push('Gemini (' + c.geminiModel + '): HTTP ' + r.getResponseCode());
    var rm = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50',
      { headers: { 'x-goog-api-key': c.geminiKey }, muteHttpExceptions: true });
    if (rm.getResponseCode() === 200) {
      var list = (JSON.parse(rm.getContentText()).models || [])
        .map(function (m) { return String(m.name || '').replace(/^models\//, ''); })
        .filter(function (n) { return /flash/i.test(n); });
      out.push('Modelos flash disponibles: ' + (list.join(', ') || '(ninguno)'));
    }
    var cache = CacheService.getScriptCache();
    cache.remove('ocr_ok_model');
    var probeContents = [{ parts: [{ text: 'Responde {"ok":true}' }] }];
    var candidates = ocrModelCandidates_(c, '');
    var probeTried = [];
    var okModel = '';
    var okMode = '';
    for (var i = 0; i < candidates.length; i++) {
      cache.remove('think_mode_' + candidates[i]);
      var rpRes = fetchGeminiModel_(candidates[i], probeContents, 256, c.geminiKey, cache);
      if (rpRes.fetchError || !rpRes.attempt) {
        probeTried.push(candidates[i] + ':ERR');
        continue;
      }
      var st = rpRes.attempt.getResponseCode();
      if (st === 200) {
        var pd = null;
        try { pd = JSON.parse(rpRes.attempt.getContentText()); } catch (e) { pd = null; }
        var ext = extractOcrJson(pd);
        if (ext.ok) {
          probeTried.push(candidates[i] + ':200(OK,' + rpRes.mode + ')');
          okModel = candidates[i];
          okMode = rpRes.mode;
          cache.put('ocr_ok_model', okModel, 1800);
          break;
        }
        probeTried.push(candidates[i] + ':200(' + ext.reason + ')');
      } else {
        probeTried.push(candidates[i] + ':' + st);
      }
    }
    var okSummary = okModel ? ('OK (' + okModel + ', think=' + String(okMode || '').toUpperCase() + ')') : 'SIN RESPUESTA VÁLIDA';
    out.push('Gemini OCR prueba: ' + okSummary + ' [' + probeTried.join(', ') + ']');
  } catch (e) { out.push('Gemini: ERROR ' + e.message); }
  console.log(out.join('\n'));
  return out;
}
