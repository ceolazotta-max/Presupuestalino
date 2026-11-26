const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../apps-script/Logic.js');
const { validateRxValue } = require('../web/js/validate.js');
const Mock = require('../web/js/mock.js');
const Q = require('../web/js/quote.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const now = 1_800_000_000;
const cfg = { clientId: 'cid.apps.googleusercontent.com', domain: 'optica.com.ar', allowedEmails: [] };
const good = {
  iss: 'https://accounts.google.com', aud: cfg.clientId, exp: now + 600,
  email: 'Ana@optica.com.ar', email_verified: true, hd: 'optica.com.ar'
};

test('normalizeName quita tildes y símbolos', () => {
  assert.equal(L.normalizeName('José Pérez-Núñez'), 'Jose-Perez-Nunez');
  assert.equal(L.normalizeName('  ../..  '), 'sin-nombre');
  assert.equal(L.normalizeName('a'.repeat(100)).length, 60);
});

test('buildPhotoFileName formato YYYY-MM-DD_HHmmss_Nombre.jpg', () => {
  assert.equal(L.buildPhotoFileName('2026-11-13_182700', 'María Gómez', 'image/jpeg'),
    '2026-11-13_182700_Maria-Gomez.jpg');
  assert.equal(L.buildPhotoFileName('2026-11-13_182700', 'x', 'image/png'), '2026-11-13_182700_x.png');
});

test('decodeJwtPayload', () => {
  const tok = `h.${b64(good)}.sig`;
  assert.equal(L.decodeJwtPayload(tok, dec).email, good.email);
  assert.throws(() => L.decodeJwtPayload('basura', dec));
});

test('precheckClaims acepta token válido y normaliza email', () => {
  const r = L.precheckClaims(good, cfg, now);
  assert.equal(r.ok, true);
  assert.equal(r.email, 'ana@optica.com.ar');
});

test('precheckClaims rechaza casos inválidos', () => {
  const cases = [
    [{ ...good, iss: 'evil.com' }, 401],
    [{ ...good, aud: 'otra-app' }, 401],
    [{ ...good, exp: now - 1 }, 401],
    [{ ...good, email_verified: false }, 401],
    [{ ...good, hd: undefined, email: 'x@gmail.com' }, 403],
    [{ ...good, hd: 'otra.com' }, 403]
  ];
  for (const [c, code] of cases) assert.equal(L.precheckClaims(c, cfg, now).code, code);
  const allow = { ...cfg, allowedEmails: ['beto@optica.com.ar'] };
  assert.equal(L.precheckClaims(good, allow, now).code, 403);

  const gmailCfg = { clientId: cfg.clientId, domain: '', allowedEmails: ['ceo.lazotta@gmail.com'] };
  const gmailOk = L.precheckClaims({ ...good, hd: undefined, email: 'ceo.lazotta@gmail.com' }, gmailCfg, now);
  assert.equal(gmailOk.ok, true);
  assert.equal(gmailOk.email, 'ceo.lazotta@gmail.com');
  assert.equal(L.precheckClaims({ ...good, hd: undefined, email: 'intruso@gmail.com' }, gmailCfg, now).code, 403);
  assert.equal(L.precheckClaims(good, { clientId: cfg.clientId, domain: '', allowedEmails: [] }, now).code, 500);
});

test('parseDataUrl valida tipo y tamaño', () => {
  const ok = L.parseDataUrl('data:image/jpeg;base64,' + Buffer.from('hola').toString('base64'));
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal(ok.bytes, 4);
  assert.throws(() => L.parseDataUrl('data:text/html;base64,AAAA'), /no permitido/);
  assert.throws(() => L.parseDataUrl('nada'));
  const big = 'A'.repeat(Math.ceil(L.MAX_IMAGE_BYTES * 4 / 3) + 8);
  assert.throws(() => L.parseDataUrl('data:image/png;base64,' + big), /grande/);
});

test('sanitizeCell neutraliza fórmulas pero no números con signo', () => {
  assert.equal(L.sanitizeCell('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(L.sanitizeCell('@foo'), "'@foo");
  assert.equal(L.sanitizeCell('+cmd|x'), "'+cmd|x");
  assert.equal(L.sanitizeCell('-2.25'), '-2.25');
  assert.equal(L.sanitizeCell('+1,50'), '+1,50');
  assert.equal(L.sanitizeCell(null), '');
  assert.equal(L.sanitizeCell('x'.repeat(2000)).length, 1000);
});

test('buildRow respeta encabezados existentes, agrega faltantes y preserva valores al actualizar', () => {
  const r = L.buildRow(['Fecha', 'Usuario', 'Otra', ''], [['Usuario', 'ana'], ['Nueva', 'v'], ['Fecha', 't']]);
  assert.deepEqual(r.headers, ['Fecha', 'Usuario', 'Otra', 'Nueva']);
  assert.deepEqual(r.row, ['t', 'ana', '', 'v']);
  assert.deepEqual(r.added, ['Nueva']);
  assert.deepEqual(L.buildRow([], [['A', 1]]).headers, ['A']);

  const upd = L.buildRow(['UUID', 'Foto', 'Estado'], [['Estado', 'PRESUPUESTADO']], ['u-1', 'https://foto', 'INCOMPLETO']);
  assert.deepEqual(upd.row, ['u-1', 'https://foto', 'PRESUPUESTADO']);
});

test('schema Gemini cubre todos los campos', () => {
  const f = L.buildRxFields();
  const s = L.buildRxSchema(f);
  assert.equal(f.length, 26);
  assert.equal(new Set(f.map((x) => x.key)).size, 26);
  assert.deepEqual(Object.keys(s.properties.campos.properties), f.map((x) => x.key));
  const inst = f.find((x) => x.key === 'institucion');
  assert.equal(inst.required, true);
  assert.ok(f.some((x) => x.key === 'matricula_esp'));
  assert.ok(f.some((x) => x.key === 'ametropias'));
});

test('isValidUuid / parseCsvList / sanitizeExtraFields', () => {
  assert.ok(L.isValidUuid('3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'));
  assert.ok(!L.isValidUuid('x'));
  assert.deepEqual(L.parseCsvList(' A@x.com, ,b@x.com'), ['a@x.com', 'b@x.com']);
  const ex = L.sanitizeExtraFields([
    { label: 'Teléfono<script>', value: '=1+1' },
    { label: '¿De dónde nos conoce?', value: 'Calle' },
    { label: '', value: 'x' }
  ]);
  assert.deepEqual(ex, [
    { label: 'Teléfonoscript', value: "'=1+1" },
    { label: '¿De dónde nos conoce?', value: 'Calle' }
  ]);
  assert.equal(L.sanitizeExtraFields(new Array(50).fill({ label: 'a', value: 'b' })).length, 30);
});

test('validateRxValue ópticos', () => {
  assert.equal(validateRxValue('esfera', '-2.25'), '');
  assert.equal(validateRxValue('esfera', '+1,50'), '');
  assert.equal(validateRxValue('esfera', 'plano'), '');
  assert.match(validateRxValue('esfera', '-2.30'), /0.25/);
  assert.match(validateRxValue('cilindro', '-12'), /rango/);
  assert.equal(validateRxValue('eje', '90°'), '');
  assert.match(validateRxValue('eje', '200'), /rango/);
  assert.equal(validateRxValue('adicion', '2.00'), '');
  assert.equal(validateRxValue('dip', '31/31'), '');
  assert.equal(validateRxValue('dip', '64'), '');
  assert.match(validateRxValue('dip', 'abc'), /Formato/);
  assert.equal(validateRxValue('text', 'lo que sea'), '');
  assert.equal(validateRxValue('esfera', ''), '');
});

test('mockFields coincide con buildRxFields de Logic.js', () => {
  assert.deepEqual(Mock.mockFields(), L.buildRxFields());
});

test('Mock.handle simula ocr y save', async () => {
  const ocr = await Mock.handle({ action: 'ocr' });
  assert.equal(ocr.ok, true);
  assert.equal(ocr.fields.length, 26);

  const save = await Mock.handle({ action: 'save', photoName: 'María Gómez' });
  assert.equal(save.ok, true);
  assert.equal(save.demo, true);
  assert.match(save.fotoNombre, /^\d{4}-\d{2}-\d{2}_\d{6}_Maria-Gomez\.jpg$/);

  const cat = await Mock.handle({ action: 'catalog' });
  assert.equal(cat.ok, true);
  assert.equal(cat.items.length, Q.SEED_CATALOG.length);
  assert.equal(cat.paymentConfig.cashDiscountPct, 10);
  assert.ok(Array.isArray(cat.convenios) && cat.convenios.includes('PAMI'));
});

test('Quote.normalizeEyeRx transpone cilindro positivo a negativo', () => {
  const tr = Q.normalizeEyeRx('-1.00', '+2.50', '90', '', '');
  assert.equal(tr.transposed, true);
  assert.equal(tr.esf_t, 1.5);
  assert.equal(tr.cil_t, -2.5);
  assert.equal(tr.eje_t, 180);

  const neg = Q.normalizeEyeRx('-2.25', '-0.75', '180', '', '');
  assert.equal(neg.transposed, false);
  assert.equal(neg.esf_t, -2.25);
  assert.equal(neg.cil_t, -0.75);
});

test('Quote evalúa Stock, Rango Extendido y Laboratorio por medio par independiente', () => {
  const od = Q.normalizeEyeRx('-1.50', '-0.50', '90', '', '');
  const oiExt = Q.normalizeEyeRx('-1.50', '-2.75', '90', '', '');
  const oiLab = Q.normalizeEyeRx('-1.50', '-5.00', '90', '', '');
  assert.equal(Q.getEyeMinTier(od, 'lejos').tipo, 'Stock');
  assert.equal(Q.getEyeMinTier(oiExt, 'lejos').tipo, 'Rango Extendido');
  assert.equal(Q.getEyeMinTier(oiLab, 'lejos').tipo, 'Laboratorio');
  assert.equal(Q.canEyeUseStock(od, 'lejos').ok, true);
  assert.equal(Q.canEyeUseStock(oiExt, 'lejos').ok, false);

  const stk = Q.SEED_CATALOG.find((p) => p.codigo === 'STK-150-AR');
  const ext = Q.SEED_CATALOG.find((p) => p.codigo === 'EXT-156-AR');
  const lab = Q.SEED_CATALOG.find((p) => p.codigo === 'LAB-150-AR');
  assert.equal(Q.checkProductForEye(stk, od, 'lejos').allowed, true);
  assert.equal(Q.checkProductForEye(stk, oiExt, 'lejos').allowed, false);
  assert.equal(Q.checkProductForEye(ext, oiExt, 'lejos').allowed, true);
  assert.equal(Q.checkProductForEye(ext, oiLab, 'lejos').allowed, false);
  assert.equal(Q.checkProductForEye(lab, oiLab, 'lejos').allowed, true);

  // En ambos ojos, si requiredTierRank es 2 (Rango Extendido), Stock queda bloqueado incluso en OD
  assert.equal(Q.checkProductForEye(stk, od, 'lejos', 2).allowed, false);
  assert.equal(Q.checkProductForEye(ext, od, 'lejos', 2).allowed, true);

  // Suma meridiana (-7.00 + -2.00 = -9.00) supera sumaMax 8 de STK-150-AR
  const highSum = Q.normalizeEyeRx('-7.00', '-2.00', '180', '', '');
  assert.equal(Q.checkProductForEye(stk, highSum, 'lejos').allowed, false);

  // Prisma y Multifocal bloquean Stock
  assert.equal(Q.canEyeUseStock(Q.normalizeEyeRx('-1.00', '0', '0', '', '2 BI'), 'lejos').ok, false);
  assert.equal(Q.canEyeUseStock(od, 'multifocal').ok, false);
});

test('Quote.validateQuote detecta bloqueos duros, regla ambos ojos y advertencias', () => {
  const rx = {
    lejos_od_esfera: '-5.00', lejos_od_cilindro: '-0.50', lejos_od_eje: '90',
    lejos_oi_esfera: '-1.50', lejos_oi_cilindro: '-2.75', lejos_oi_eje: '180',
    adicion: '', dip: '', prisma: ''
  };
  const badState = {
    uso: 'lejos',
    eyesMode: 'both',
    od: { mode: 'catalog', codigo: 'STK-150-BL', price: 18000 },
    oi: { mode: 'catalog', codigo: 'STK-150-AR', price: 26000 },
    frame: { mode: 'nuevo', rimType: 'aire', marca: 'Vulk', modelo: 'V-1', color: 'Negro', price: 30000 }
  };
  const v1 = Q.validateQuote(rx, badState, Q.SEED_CATALOG);
  assert.ok(v1.errors.some((e) => e.includes('OI:') && /Rango Extendido/i.test(e)));
  assert.ok(v1.errors.some((e) => e.includes('OD:') && /Requiere nivel Rango Extendido/i.test(e)));
  assert.ok(v1.warnings.some((w) => w.includes('tratamiento')));
  assert.ok(v1.warnings.some((w) => w.includes('graduación alta')));
  assert.ok(v1.warnings.some((w) => w.includes('al aire')));
  assert.ok(v1.warnings.some((w) => w.includes('DIP')));

  // Si OI lleva Laboratorio, OD con Stock/Rango Extendido dispara error de rango distinto
  const mixedTier = {
    uso: 'lejos',
    eyesMode: 'both',
    od: { mode: 'catalog', codigo: 'EXT-156-AR', price: 36000 },
    oi: { mode: 'catalog', codigo: 'LAB-150-AR', price: 42000 },
    frame: { mode: 'none', price: 0 }
  };
  const vMix = Q.validateQuote(rx, mixedTier, Q.SEED_CATALOG);
  assert.ok(vMix.errors.some((e) => e.includes('mismo rango')));

  // Multifocal sin Adición ni Cerca → error bloqueante
  const vMulti = Q.validateQuote(rx, { ...badState, uso: 'multifocal' }, Q.SEED_CATALOG);
  assert.ok(vMulti.errors.some((e) => e.includes('Adición')));
});

test('Quote.calculateTotals aplica precio mayor a ambos ojos, descuento, efectivo y Plan Cristalino', () => {
  const t = Q.calculateTotals({
    eyesMode: 'both',
    od: { price: 26000 },
    oi: { price: 42000 },
    frame: { mode: 'nuevo', price: 32000 },
    discount: 10000,
    deposit: 20000
  });
  // Regla: mayor graduación/precio (42000) se aplica a ambos cristales
  assert.equal(t.odPrice, 42000);
  assert.equal(t.oiPrice, 42000);
  assert.equal(t.subtotal, 116000);
  assert.equal(t.listTotal, 106000);
  assert.equal(t.balanceBase, 86000);
  assert.equal(t.cashTotal, 77400);
  assert.equal(t.transferTotal, 86000);
  assert.equal(t.cristalinoOptions[0].cuotas, 2);
  assert.equal(t.cristalinoOptions[0].total, 96320);
  assert.equal(t.cristalinoOptions[0].cuotaMensual, 48160);

  // Medio par único (Solo OD) ignora precio OI
  const soloOd = Q.calculateTotals({
    eyesMode: 'od',
    od: { price: 26000 },
    oi: { price: 42000 },
    frame: { mode: 'propio', price: 50000 }
  });
  assert.equal(soloOd.listTotal, 26000);
});

test('Logic catálogo y medios de pago sincronizados con Quote', () => {
  assert.deepEqual(L.SEED_CATALOG_ITEMS, Q.SEED_CATALOG);
  const rows = [L.CATALOG_HEADERS, ...L.SEED_CATALOG_ITEMS.map(L.catalogItemToRow)];
  const parsed = L.parseCatalogRows(rows);
  assert.equal(parsed.length, Q.SEED_CATALOG.length);
  assert.ok(parsed.some((p) => p.tipo === 'Rango Extendido'));

  const manual = L.sanitizeCatalogItem({
    nombre: 'Multifocal 1.60 AR', tipo: 'Stock', diseno: 'Multifocal',
    indice: '1.60', tratamiento: 'AR', precioMedioPar: 85000
  }, 'T1');
  assert.equal(manual.tipo, 'Laboratorio'); // Multifocal fuerza Laboratorio
  assert.equal(manual.precioMedioPar, 85000);

  const manualExt = L.sanitizeCatalogItem({
    nombre: 'Orgánico 1.56 Rango Ext', tipo: 'Rango Extendido', diseno: 'Monofocal',
    indice: '1.56', tratamiento: 'AR', precioMedioPar: 36000
  }, 'T2');
  assert.equal(manualExt.tipo, 'Rango Extendido');
  assert.equal(manualExt.cilMax, 4);

  const payCfg = L.parsePaymentRows([L.PAYMENT_HEADERS, ...L.SEED_PAYMENT_ROWS]);
  assert.equal(payCfg.cashDiscountPct, 10);
  assert.equal(payCfg.transferSurchargePct, 0);
  assert.equal(payCfg.cardPlans.length, 5);
  assert.equal(payCfg.cardPlans[0].marca, 'Visa / Mastercard');
  assert.equal(payCfg.cardPlans[3].marca, 'Naranja X');
  assert.equal(payCfg.cardPlans[3].plan, 'Plan Z (3 cuotas)');
  assert.equal(payCfg.cristalinoPlans.length, 3);
  assert.equal(payCfg.cristalinoPlans[0].surchargePct, 12);

  // Fallback legado sin columna Marca_Banco: infiere marca desde Medio ("Tarjeta Visa")
  const legacyCfg = L.parsePaymentRows([
    ['Medio', 'Plan', 'Cuotas', 'Recargo_Porcentaje', 'Activo'],
    ['Tarjeta Visa', '3 cuotas', 3, 18, 'Sí'],
    ['Tarjeta', '1 cuota', 1, 0, 'Sí']
  ]);
  assert.equal(legacyCfg.cardPlans.length, 2);
  assert.equal(legacyCfg.cardPlans[0].marca, 'Visa');
  assert.equal(legacyCfg.cardPlans[1].marca, 'General');

  const totals = Q.calculateTotals({
    uso: 'lejos',
    eyesMode: 'od',
    od: { price: 100000 },
    oi: {},
    frame: { mode: 'none', price: 0 },
    discount: 0,
    deposit: 0
  }, payCfg);
  assert.equal(totals.cardGroups.length, 2);
  assert.equal(totals.cardGroups[0].marca, 'Visa / Mastercard');
  assert.equal(totals.cardGroups[0].options.length, 3);
  assert.equal(totals.cardGroups[0].options[1].total, 115000);
  assert.equal(totals.cardGroups[1].marca, 'Naranja X');
  assert.equal(totals.cardGroups[1].options.length, 2);
  assert.equal(totals.cardGroups[1].options[0].plan, 'Plan Z (3 cuotas)');
  assert.equal(totals.cardGroups[1].options[0].total, 110000);
});

test('Logic.normalizeOcrResult completa las 26 claves y normaliza anotaciones', () => {
  const fields = L.buildRxFields();
  const norm = L.normalizeOcrResult({
    es_receta_optica: true,
    campos: {
      lejos_od_esfera: { valor: '-2.00', confianza: 'alta' },
      lejos_oi_esfera: '-1.50'
    },
    anotaciones_extra: [
      { texto: 'Antirreflejo', ubicacion: 'centro' },
      'sello médico',
      { texto: '   ' }
    ]
  }, fields);
  assert.equal(norm.es_receta_optica, true);
  assert.equal(Object.keys(norm.campos).length, 26);
  assert.deepEqual(norm.campos.lejos_od_esfera, { valor: '-2.00', confianza: 'alta' });
  assert.deepEqual(norm.campos.lejos_oi_esfera, { valor: '-1.50', confianza: 'media' });
  assert.deepEqual(norm.campos.lejos_od_cilindro, { valor: null, confianza: 'baja' });
  assert.equal(norm.anotaciones_extra.length, 2);
  assert.equal(norm.anotaciones_extra[1].texto, 'sello médico');
});

test('Logic.formatPersonName y Logic.toSheetValue', () => {
  assert.equal(L.formatPersonName('PEREZ, JUAN'), 'Perez Juan');
  assert.equal(L.formatPersonName('Dra. MARÍA GÓMEZ'), 'María Gómez');
  assert.equal(L.formatPersonName('  '), '');

  assert.strictEqual(L.toSheetValue('-2.25'), -2.25);
  assert.strictEqual(L.toSheetValue('+1,50'), 1.5);
  assert.strictEqual(L.toSheetValue('180'), 180);
  assert.strictEqual(L.toSheetValue('26000'), 26000);
  assert.strictEqual(L.toSheetValue('0.00'), 0);
  assert.strictEqual(L.toSheetValue('31/31'), '31/31');
  assert.strictEqual(L.toSheetValue('=SUM(A1)'), "'=SUM(A1)");

  const ext = L.sanitizeExtraFields([
    { key: 'nombre', label: 'Apellido y Nombre cliente', value: 'GOMEZ, ANA' },
    { key: 'derivacion_doctor', label: 'Nombre Doctor', value: 'dr. lopez carlos' },
    { key: 'origen_nombre', label: 'Nombre', value: 'MARTINEZ, LUIS' },
    { key: 'notas', label: 'Notas', value: '' }
  ]);
  assert.deepEqual(ext, [
    { label: 'Nombre cliente', value: 'Gomez Ana' },
    { label: 'Nombre Doctor', value: 'Lopez Carlos' },
    { label: 'Nombre Recomendador', value: 'Martinez Luis' },
    { label: 'Notas', value: '' }
  ]);
});

test('Opciones múltiples independientes generan filas separadas con Opción # y mismo UUID', () => {
  const payCfg = L.parsePaymentRows([L.PAYMENT_HEADERS, ...L.SEED_PAYMENT_ROWS]);
  const shared = { frame: { mode: 'nuevo', price: 30000 }, discount: 5000, deposit: 20000 };
  const opt1 = Q.calculateTotals({ eyesMode: 'both', od: { price: 26000 }, oi: { price: 26000 }, ...shared }, payCfg);
  const opt2 = Q.calculateTotals({ eyesMode: 'od', od: { price: 42000 }, oi: { price: 0 }, ...shared }, payCfg);
  assert.equal(opt1.listTotal, 77000);
  assert.equal(opt1.balanceBase, 57000);
  assert.equal(opt2.listTotal, 67000);
  assert.equal(opt2.balanceBase, 47000);

  const row1 = L.buildRow(
    ['UUID', 'Nombre cliente', 'Opción #', 'Total Lista'],
    [['UUID', 'u-multi'], ['Nombre cliente', 'Gomez Ana'], ['Opción #', 1], ['Total Lista', opt1.listTotal]],
    []
  );
  const row2 = L.buildRow(
    row1.headers,
    [['UUID', 'u-multi'], ['Nombre cliente', 'Gomez Ana'], ['Opción #', 2], ['Total Lista', opt2.listTotal]],
    row1.row
  );
  assert.deepEqual(row1.row, ['u-multi', 'Gomez Ana', 1, 77000]);
  assert.deepEqual(row2.row, ['u-multi', 'Gomez Ana', 2, 67000]);
});

test('Logic.extractOcrJson ignora partes thought, limpia markdown y detecta truncado', () => {
  // JSON limpio
  const ok1 = L.extractOcrJson({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"es_receta_optica":true,"campos":{}}' }] } }]
  });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.parsed.es_receta_optica, true);

  // Parte thought en parts[0] + JSON en parts[1]
  const ok2 = L.extractOcrJson({
    candidates: [{
      finishReason: 'STOP',
      content: {
        parts: [
          { thought: true, text: 'Voy a analizar...' },
          { text: '```json\n{"es_receta_optica":false,"campos":{}}\n```' }
        ]
      }
    }]
  });
  assert.equal(ok2.ok, true);
  assert.equal(ok2.parsed.es_receta_optica, false);

  // JSON envuelto en texto extra
  const ok3 = L.extractOcrJson({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Resultado:\n{"es_receta_optica":true,"campos":{"x":{"valor":"1"}}}\nFin' }] } }]
  });
  assert.equal(ok3.ok, true);
  assert.equal(ok3.parsed.campos.x.valor, '1');

  // Truncado por MAX_TOKENS -> reason: 'truncated'
  const badTrunc = L.extractOcrJson({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"es_receta_optica":true,"campos":{"lejos_od' }] } }]
  });
  assert.equal(badTrunc.ok, false);
  assert.equal(badTrunc.reason, 'truncated');

  // Vacío o no-JSON -> ok: false
  assert.equal(L.extractOcrJson({ candidates: [] }).ok, false);
  assert.equal(L.extractOcrJson({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'texto plano sin json' }] } }]
  }).reason, 'invalid_json');
});

test('Logic.thinkingModesForModel y buildOcrGenerationConfig usan enums MAYÚSCULAS y orden correcto', () => {
  assert.deepEqual(L.thinkingModesForModel('gemini-3.5-flash-lite', ''), ['minimal', 'low', 'budget0', 'none']);
  assert.deepEqual(L.thinkingModesForModel('gemini-3.5-flash-lite', 'low'), ['low', 'minimal', 'budget0', 'none']);
  assert.deepEqual(L.thinkingModesForModel('gemini-2.5-flash', ''), ['budget0', 'none']);
  assert.deepEqual(L.thinkingModesForModel('gemini-3.5-flash', 'invalid_mode'), ['minimal', 'low', 'budget0', 'none']);

  const minCfg = L.buildOcrGenerationConfig('minimal', 0);
  assert.equal(minCfg.maxOutputTokens, 1400);
  assert.deepEqual(minCfg.thinkingConfig, { thinkingLevel: 'MINIMAL' });

  const lowCfg = L.buildOcrGenerationConfig('low', 0);
  assert.equal(lowCfg.maxOutputTokens, 2048);
  assert.deepEqual(lowCfg.thinkingConfig, { thinkingLevel: 'LOW' });

  const b0Cfg = L.buildOcrGenerationConfig('budget0', 256);
  assert.equal(b0Cfg.maxOutputTokens, 256);
  assert.deepEqual(b0Cfg.thinkingConfig, { thinkingBudget: 0 });

  const noneCfg = L.buildOcrGenerationConfig('none', 0);
  assert.equal(noneCfg.maxOutputTokens, 1800);
  assert.equal(noneCfg.thinkingConfig, undefined);
});

test('sanitizeExtraFields normaliza DNI y Nombre Secretaria', () => {
  const ext = L.sanitizeExtraFields([
    { key: 'dni', label: 'DNI', value: '30.123.456' },
    { key: 'derivacion_secretaria', label: 'Nombre Secretaria', value: '  GOMEZ, LUCIA  ' }
  ]);
  assert.deepEqual(ext, [
    { label: 'DNI', value: 30123456 },
    { label: 'Nombre Secretaria', value: 'Gomez Lucia' }
  ]);
});

test('Quote exige cristal idéntico en ambos ojos, valida por par y calcula armazón por bloque', () => {
  const rx = {
    lejos_od_esfera: '-1.00', lejos_od_cilindro: '-0.50', lejos_od_eje: '90',
    lejos_oi_esfera: '-1.00', lejos_oi_cilindro: '-2.75', lejos_oi_eje: '180'
  };
  const eff = Q.resolveEffectiveRx(rx, 'lejos');
  const stk = Q.SEED_CATALOG.find((p) => p.codigo === 'STK-150-AR');
  const ext1 = Q.SEED_CATALOG.find((p) => p.codigo === 'EXT-156-AR');
  const ext2 = Q.SEED_CATALOG.find((p) => p.codigo === 'EXT-159-BC');

  // STK-150-AR no pasa por el par completo porque OI necesita Rango Extendido
  assert.equal(Q.checkProductForPair(stk, eff.od, eff.oi, 'lejos').allowed, false);
  assert.equal(Q.checkProductForPair(ext1, eff.od, eff.oi, 'lejos').allowed, true);

  // Dos cristales distintos del mismo rango en eyesMode: 'both' -> error bloqueante
  const mismatch = Q.validateQuote(rx, {
    uso: 'lejos',
    eyesMode: 'both',
    od: { mode: 'catalog', codigo: 'EXT-156-AR', price: 36000 },
    oi: { mode: 'catalog', codigo: 'EXT-159-BC', price: 48000 }
  }, Q.SEED_CATALOG);
  assert.ok(mismatch.errors.some((e) => e.includes('coincidir exactamente')));

  // Armazón distinto por bloque de cristales
  assert.equal(Q.areSameEyeProduct(
    { mode: 'catalog', codigo: 'EXT-156-AR' },
    { mode: 'catalog', codigo: 'EXT-156-AR' },
    ext1, ext1
  ), true);
  assert.equal(Q.areSameEyeProduct(
    { mode: 'catalog', codigo: 'EXT-156-AR' },
    { mode: 'catalog', codigo: 'EXT-159-BC' },
    ext1, ext2
  ), false);

  const grp1 = Q.calculateTotals({
    eyesMode: 'both', od: { price: 36000 }, oi: { price: 36000 },
    frame: { mode: 'nuevo', price: 20000 }, discount: 0, deposit: 0
  });
  const grp2 = Q.calculateTotals({
    eyesMode: 'both', od: { price: 36000 }, oi: { price: 36000 },
    frame: { mode: 'propio', price: 99999 }, discount: 0, deposit: 0
  });
  assert.equal(grp1.listTotal, 92000);
  assert.equal(grp2.listTotal, 72000);
});

test('Logic.searchBudgetsInSheetRows busca por nombre o DNI, agrupa UUID e incluye ANULADO ordenado por fecha desc', async () => {
  const rows = [
    ['Timestamp', 'Última actualización', 'UUID', 'Estado', 'Nombre cliente', 'DNI', 'Paciente', 'DNI paciente', 'Derivación', 'Nombre Secretaria', 'Opción #', 'Uso anteojo', 'Ojos cotizados', '½ Par OD', 'Tipo OD', 'Precio ½ OD', 'Armazón', 'Precio Armazón', 'Total Lista', 'Foto'],
    ['2026-11-10 10:00:00', '2026-11-10 10:00:00', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ANULADO', 'Pérez Juan', 30123456, 'Pérez Juan', 30123456, 'Derivado por Secretaria', 'Lucía', 1, 'lejos', 'both', 'Orgánico 1.50 Blanco', 'Stock', 18000, '', 0, 36000, ''],
    ['2026-11-22 15:00:00', '2026-11-22 15:05:00', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'PRESUPUESTADO', 'Pérez Juan', 30123456, 'Pérez Juan', 30123456, 'No Derivado', '', 2, 'cerca', 'both', 'Orgánico 1.56 Blue Cut', 'Stock', 34000, 'Armazón nuevo · Aro completo · Azul', 25000, 93000, 'https://drive.google.com/file/d/abc/view'],
    ['2026-11-22 15:00:00', '2026-11-22 15:05:00', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'PRESUPUESTADO', 'Pérez Juan', 30123456, 'Pérez Juan', 30123456, 'No Derivado', '', 1, 'lejos', 'both', 'Orgánico 1.50 Antirreflejo', 'Stock', 26000, 'Armazón nuevo · Aro completo · Negro', 20000, 72000, 'https://drive.google.com/file/d/abc/view'],
    ['2026-11-25 09:00:00', '2026-11-25 09:00:00', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'INCOMPLETO', 'García Ana', 28999111, 'García Ana', 28999111, '', '', '', '', '', '', '', '', '', '', '', '']
  ];

  // Búsqueda por nombre sin tildes agrupa bbbbbbbb (2 opciones ordenadas) antes que ANULADO aaaaaaaa
  const byName = L.searchBudgetsInSheetRows(rows, 'juan perez');
  assert.equal(byName.length, 2);
  assert.equal(byName[0].uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(byName[0].options.length, 2);
  assert.equal(byName[0].options[0].opcion, 1);
  assert.equal(byName[0].options[1].opcion, 2);
  assert.equal(byName[1].estado, 'ANULADO');
  assert.equal(byName[1].extraMap.derivacion_secretaria, 'Lucía');

  // Búsqueda por DNI encuentra INCOMPLETO (acepta DNI con o sin puntos)
  const byDni = L.searchBudgetsInSheetRows(rows, '28999');
  assert.equal(byDni.length, 1);
  assert.equal(byDni[0].estado, 'INCOMPLETO');
  assert.equal(byDni[0].nombre, 'García Ana');
  assert.equal(L.searchBudgetsInSheetRows(rows, '30.123.456').length, 2);

  // Formato DNI con separador de miles y guardado sin separador
  assert.equal(L.formatDniDots('99999999'), '99.999.999');
  assert.equal(L.formatDniDots('9.999.999'), '9.999.999');
  assert.deepEqual(L.sanitizeExtraFields([{ key: 'dni', label: 'DNI', value: '99.999.999' }]), [
    { label: 'DNI', value: 99999999 }
  ]);

  // Mock.handle action 'search' funciona en modo demo
  const mockRes = await Mock.handle({ action: 'search', query: '30123' });
  assert.equal(mockRes.ok, true);
  assert.ok(mockRes.results.length >= 2);
});

test('Nuevas reglas: Convenios, orden descendente de precio, Marca/Modelo/Color obligatorios, GMT-3 y Estado por grupo vendido', () => {
  // 1) Convenios parser y sanitizeExtraFields
  const convList = L.parseConveniosRows([
    L.CONVENIOS_HEADERS,
    ...L.SEED_CONVENIOS_ROWS,
    ['Swiss Medical', 'Sí'],
    ['Swiss Medical', 'Sí'],
    ['Convenio Viejo', 'No'],
    ['Otro', 'Sí']
  ]);
  assert.ok(convList.includes('PAMI'));
  assert.ok(convList.includes('Swiss Medical'));
  assert.ok(!convList.includes('Convenio Viejo'));
  assert.ok(!convList.includes('Otro'));

  const extConv = L.sanitizeExtraFields([
    { key: 'convenio', label: 'Convenio', value: 'Otro' },
    { key: 'convenio_otro', label: 'Cuál Convenio', value: 'osdepym plan 200' }
  ]);
  assert.deepEqual(extConv, [
    { label: 'Convenio', value: 'Otro' },
    { label: 'Cuál Convenio', value: 'osdepym plan 200' }
  ]);

  // 2) Cristales ordenados por precio descendente
  const sorted = Q.sortProductsByPriceDesc(Q.SEED_CATALOG);
  assert.equal(sorted[0].precioMedioPar, 105000);
  assert.equal(sorted[sorted.length - 1].precioMedioPar, 18000);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].precioMedioPar >= sorted[i].precioMedioPar);
  }

  // 3) Marca, Modelo y Color obligatorios solo en armazón nuevo
  const rx = { lejos_od_esfera: '-1.00', lejos_oi_esfera: '-1.00' };
  const missingFrame = Q.validateQuote(rx, {
    uso: 'lejos',
    eyesMode: 'both',
    od: { mode: 'catalog', codigo: 'STK-150-AR', price: 26000 },
    oi: { mode: 'catalog', codigo: 'STK-150-AR', price: 26000 },
    frame: { mode: 'nuevo', rimType: 'completo', marca: '', modelo: '', color: '', price: 30000 }
  }, Q.SEED_CATALOG);
  assert.ok(missingFrame.errors.some((e) => e.includes('Marca')));
  assert.ok(missingFrame.errors.some((e) => e.includes('Modelo')));
  assert.ok(missingFrame.errors.some((e) => e.includes('Color')));

  const ownFrame = Q.validateQuote(rx, {
    uso: 'lejos',
    eyesMode: 'both',
    od: { mode: 'catalog', codigo: 'STK-150-AR', price: 26000 },
    oi: { mode: 'catalog', codigo: 'STK-150-AR', price: 26000 },
    frame: { mode: 'propio', rimType: 'completo', marca: '', modelo: '', color: '', price: 0 }
  }, Q.SEED_CATALOG);
  assert.equal(ownFrame.errors.length, 0);

  // 4) Formato GMT-3 (UTC-3 Argentina)
  assert.equal(L.formatArTimestamp('2026-11-25T18:25:30.575Z'), '2026-11-25 15:25:30');
  assert.equal(L.formatArTimestamp('2026-11-25 15:36:04'), '2026-11-25 15:36:04');

  // 5) Búsqueda conserva Convenio, Marca/Modelo/Color y prioriza VENTA CONCRETADA sobre NO ELEGIDA
  const rows = [
    ['Timestamp', 'Última actualización', 'UUID', 'Estado', 'Nombre cliente', 'DNI', 'Convenio', 'Cuál Convenio', 'Opción #', 'Grupo #', 'Uso anteojo', 'Ojos cotizados', '½ Par OD', 'Tipo OD', 'Precio ½ OD', 'Armazón', 'Armazón Marca', 'Armazón Modelo', 'Armazón Color', 'Precio Armazón', 'Grupo Vendido', 'Total Lista'],
    ['2026-11-26 15:00:00', '2026-11-26 15:05:00', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'VENTA CONCRETADA', 'Gómez Lucía', 33444555, 'Otro', 'DASPU', 1, 1, 'lejos', 'both', 'Orgánico 1.50 Antirreflejo', 'Stock', 26000, 'Armazón nuevo · Aro completo · Ray-Ban · RB5154 · Habana', 'Ray-Ban', 'RB5154', 'Habana', 85000, 'Sí', 137000],
    ['2026-11-26 15:00:00', '2026-11-26 15:05:00', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'NO ELEGIDA', 'Gómez Lucía', 33444555, 'Otro', 'DASPU', 2, 1, 'lejos', 'both', 'Orgánico 1.50 Antirreflejo', 'Stock', 26000, 'Armazón nuevo · Aro completo · Vulk · V-210 · Negro', 'Vulk', 'V-210', 'Negro', 45000, 'No', 97000]
  ];
  const found = L.searchBudgetsInSheetRows(rows, '33444');
  assert.equal(found.length, 1);
  assert.equal(found[0].estado, 'VENTA CONCRETADA');
  assert.equal(found[0].extraMap.convenio, 'Otro');
  assert.equal(found[0].extraMap.convenio_otro, 'DASPU');
  assert.equal(found[0].options.length, 2);
  assert.equal(found[0].options[0].grupo, 1);
  assert.equal(found[0].options[0].armazonMarca, 'Ray-Ban');
  assert.equal(found[0].options[1].armazonModelo, 'V-210');
  assert.equal(found[0].options[0].grupoVendido, 'Sí');
  assert.equal(found[0].options[1].grupoVendido, 'No');
});
