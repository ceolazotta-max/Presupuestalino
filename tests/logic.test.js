const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../apps-script/Logic.js');
const { validateRxValue } = require('../web/js/validate.js');
const Mock = require('../web/js/mock.js');

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

test('buildRow respeta encabezados existentes y agrega faltantes', () => {
  const r = L.buildRow(['Fecha', 'Usuario', 'Otra', ''], [['Usuario', 'ana'], ['Nueva', 'v'], ['Fecha', 't']]);
  assert.deepEqual(r.headers, ['Fecha', 'Usuario', 'Otra', 'Nueva']);
  assert.deepEqual(r.row, ['t', 'ana', '', 'v']);
  assert.deepEqual(r.added, ['Nueva']);
  assert.deepEqual(L.buildRow([], [['A', 1]]).headers, ['A']);
});

test('schema Gemini cubre todos los campos', () => {
  const f = L.buildRxFields();
  const s = L.buildRxSchema(f);
  assert.equal(f.length, 22);
  assert.equal(new Set(f.map((x) => x.key)).size, 22);
  assert.deepEqual(Object.keys(s.properties.campos.properties), f.map((x) => x.key));
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
  assert.equal(L.sanitizeExtraFields(new Array(50).fill({ label: 'a', value: 'b' })).length, 20);
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
  assert.equal(ocr.fields.length, 22);

  const save = await Mock.handle({ action: 'save', photoName: 'María Gómez' });
  assert.equal(save.ok, true);
  assert.equal(save.demo, true);
  assert.match(save.fotoNombre, /^\d{4}-\d{2}-\d{2}_\d{6}_Maria-Gomez\.jpg$/);
});
