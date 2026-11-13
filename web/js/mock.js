/**
 * mock.js — Backend simulado para modo demo (no guarda nada).
 * MOCK_FIELDS debe coincidir con apps-script/Logic.js (lo verifica tests/logic.test.js).
 */
(function (root) {
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function mockFields() {
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

  var V = function (valor, confianza) { return { valor: valor, confianza: confianza }; };
  var RX = {
    es_receta_optica: true,
    campos: {
      paciente: V('Juan Pérez', 'alta'),
      fecha_receta: V('12/11/2026', 'media'),
      medico: V('Dra. L. Fernández', 'media'),
      matricula: V('MN 45.120', 'baja'),
      lejos_od_esfera: V('-2.25', 'alta'), lejos_od_cilindro: V('-0.75', 'alta'), lejos_od_eje: V('180', 'media'),
      lejos_oi_esfera: V('-2.00', 'alta'), lejos_oi_cilindro: V('-0.50', 'media'), lejos_oi_eje: V('5', 'baja'),
      cerca_od_esfera: V(null, 'baja'), cerca_od_cilindro: V(null, 'baja'), cerca_od_eje: V(null, 'baja'),
      cerca_oi_esfera: V(null, 'baja'), cerca_oi_cilindro: V(null, 'baja'), cerca_oi_eje: V(null, 'baja'),
      adicion: V('+1.75', 'alta'),
      dip: V('62', 'media'),
      prisma: V(null, 'baja'),
      tipo_lente: V('Multifocal', 'media'),
      tratamientos: V('Antirreflejo', 'baja'),
      observaciones: V('Uso permanente', 'media')
    },
    anotaciones_extra: [
      { texto: 'llamar antes de entregar', ubicacion: 'margen inferior', confianza: 'media' },
      { texto: '15-4??-2210', ubicacion: 'margen superior derecho', confianza: 'baja' }
    ]
  };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function handle(payload) {
    await wait(1200);
    if (payload.action === 'ocr') {
      return { ok: true, fields: mockFields(), rx: JSON.parse(JSON.stringify(RX)), raw: JSON.stringify(RX) };
    }
    if (payload.action === 'save') {
      var copy = Object.assign({}, payload, { image: '[' + (payload.image || '').length + ' chars]' });
      console.info('[DEMO] payload que se enviaría al backend:', copy);
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      var stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' +
        p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      var name = String(payload.photoName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sin-nombre';
      return { ok: true, fila: 42, fotoUrl: '', fotoNombre: stamp + '_' + name + '.jpg', demo: true };
    }
    return { ok: false, code: 400, error: 'Acción desconocida' };
  }

  var api = { handle: handle, mockFields: mockFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mock = api;
})(typeof window !== 'undefined' ? window : this);
