/**
 * mock.js — Backend simulado para modo demo (no guarda nada).
 * MOCK_FIELDS debe coincidir con apps-script/Logic.js (lo verifica tests/logic.test.js).
 */
(function (root) {
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function mockFields() {
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

  var V = function (valor, confianza) { return { valor: valor, confianza: confianza }; };
  var RX = {
    es_receta_optica: true,
    campos: {
      paciente: V('Juan Pérez', 'alta'),
      dni: V('30123456', 'media'),
      fecha_receta: V('12/11/2026', 'media'),
      institucion: V('Clínica del Sol', 'alta'),
      medico: V('Dra. L. Fernández', 'media'),
      matricula: V('MN 45.120', 'baja'),
      matricula_esp: V('ME 15.210', 'media'),
      lejos_od_esfera: V('-2.25', 'alta'), lejos_od_cilindro: V('-0.75', 'alta'), lejos_od_eje: V('180', 'media'),
      lejos_oi_esfera: V('-2.00', 'alta'), lejos_oi_cilindro: V('-0.50', 'media'), lejos_oi_eje: V('5', 'baja'),
      cerca_od_esfera: V(null, 'baja'), cerca_od_cilindro: V(null, 'baja'), cerca_od_eje: V(null, 'baja'),
      cerca_oi_esfera: V(null, 'baja'), cerca_oi_cilindro: V(null, 'baja'), cerca_oi_eje: V(null, 'baja'),
      adicion: V('+1.75', 'alta'),
      dip: V('62', 'media'),
      prisma: V(null, 'baja'),
      ametropias: V('Miopía y astigmatismo', 'media'),
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

  function getQuoteMod() {
    if (root.Quote) return root.Quote;
    if (typeof require === 'function') return require('./quote.js');
    return null;
  }

  var demoExtraCatalog = [];
  var demoSavedUuids = {};
  var demoBudgets = [
    {
      uuid: '11111111-1111-4111-8111-111111111111',
      fecha: '2026-11-24 17:30:00',
      estado: 'PRESUPUESTADO',
      nombre: 'Pérez Juan',
      dni: '30123456',
      fotoUrl: '',
      rx: {
        paciente: 'Pérez Juan', dni: '30123456', fecha_receta: '12/11/2026', institucion: 'Clínica del Sol', medico: 'Fernández L.', matricula: 'MN 45.120', matricula_esp: 'ME 15.210',
        lejos_od_esfera: '-2.25', lejos_od_cilindro: '-0.75', lejos_od_eje: '180',
        lejos_oi_esfera: '-2.00', lejos_oi_cilindro: '-0.50', lejos_oi_eje: '5',
        cerca_od_esfera: '', cerca_od_cilindro: '', cerca_od_eje: '',
        cerca_oi_esfera: '', cerca_oi_cilindro: '', cerca_oi_eje: '',
        adicion: '+1.75', dip: '62', prisma: '', ametropias: 'Miopía y astigmatismo', tipo_lente: 'Multifocal', tratamientos: 'Antirreflejo', observaciones: 'Uso permanente'
      },
      extras: ['llamar antes de entregar'],
      extraMap: {
        nombre: 'Pérez Juan', dni: '30123456', telefono: '3515550101', email: 'juan@ejemplo.com',
        convenio: 'OSDE', convenio_otro: '',
        derivacion: 'Derivado por Secretaria', derivacion_doctor: '', derivacion_secretaria: 'Lucía',
        origen: 'Calle', origen_nombre: '', origen_red: '', notas: 'Demo vigente', vendedor: 'Gabriel'
      },
      options: [{
        opcion: 1, grupo: 1, uso: 'lejos', eyesMode: 'both',
        odNombre: 'Orgánico 1.50 Antirreflejo', odTipo: 'Stock', odPrecio: '26000',
        oiNombre: 'Orgánico 1.50 Antirreflejo', oiTipo: 'Stock', oiPrecio: '26000',
        armazon: 'Armazón nuevo · Aro completo · Vulk · V-210 · Negro mate',
        armazonMarca: 'Vulk', armazonModelo: 'V-210', armazonColor: 'Negro mate',
        armazonPrecio: '45000',
        descuento: '5000 (Promo)', sena: '10000', totalLista: '92000'
      }]
    },
    {
      uuid: '22222222-2222-4222-8222-222222222222',
      fecha: '2026-11-18 11:15:00',
      estado: 'ANULADO',
      nombre: 'Pérez Juan',
      dni: '30123456',
      fotoUrl: '',
      rx: {
        paciente: 'Pérez Juan', dni: '30123456', fecha_receta: '12/11/2026', institucion: 'PAMI', medico: 'Fernández L.', matricula: 'MN 45.120', matricula_esp: '',
        lejos_od_esfera: '-2.25', lejos_od_cilindro: '-0.75', lejos_od_eje: '180',
        lejos_oi_esfera: '-2.00', lejos_oi_cilindro: '-0.50', lejos_oi_eje: '5',
        cerca_od_esfera: '', cerca_od_cilindro: '', cerca_od_eje: '',
        cerca_oi_esfera: '', cerca_oi_cilindro: '', cerca_oi_eje: '',
        adicion: '+1.75', dip: '62', prisma: '', ametropias: 'Miopía', tipo_lente: 'Multifocal', tratamientos: 'Blue Cut', observaciones: ''
      },
      extras: [],
      extraMap: {
        nombre: 'Pérez Juan', dni: '30123456', telefono: '3515550101', email: 'juan@ejemplo.com',
        convenio: 'PAMI', convenio_otro: '',
        derivacion: 'No Derivado', derivacion_doctor: '', derivacion_secretaria: '',
        origen: 'Calle', origen_nombre: '', origen_red: '', notas: '', vendedor: 'Micaela'
      },
      options: [{
        opcion: 1, grupo: 1, uso: 'lejos', eyesMode: 'both',
        odNombre: 'Orgánico 1.56 Blue Cut', odTipo: 'Stock', odPrecio: '34000',
        oiNombre: 'Orgánico 1.56 Blue Cut', oiTipo: 'Stock', oiPrecio: '34000',
        armazon: '', armazonMarca: '', armazonModelo: '', armazonColor: '', armazonPrecio: '0',
        descuento: '0', sena: '0', totalLista: '68000'
      }]
    }
  ];

  function normDemo_(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  async function handle(payload) {
    if (payload.action === 'catalog') {
      await wait(150);
      var q = getQuoteMod();
      var base = q ? q.SEED_CATALOG : [];
      var payCfg = q ? q.DEFAULT_PAYMENT_CONFIG : null;
      var convenios = ['Sin convenio / Particular', 'PAMI', 'APROSS', 'OSDE', 'OSECAC'];
      return { ok: true, items: base.concat(demoExtraCatalog), paymentConfig: payCfg, convenios: convenios };
    }
    if (payload.action === 'search') {
      await wait(150);
      var qStr = normDemo_(payload.query);
      var qDig = String(payload.query || '').replace(/\D+/g, '');
      var hits = demoBudgets.filter(function (b) {
        var nameOk = qStr.length >= 2 && normDemo_(b.nombre).indexOf(qStr) >= 0;
        var dniOk = qDig.length >= 3 && String(b.dni || '').replace(/\D+/g, '').indexOf(qDig) >= 0;
        return nameOk || dniOk;
      }).sort(function (a, b) { return String(b.fecha).localeCompare(String(a.fecha)); });
      return { ok: true, results: hits };
    }
    await wait(payload.stage === 'incompleto' ? 200 : 800);
    if (payload.action === 'ocr') {
      return { ok: true, fields: mockFields(), rx: JSON.parse(JSON.stringify(RX)), raw: JSON.stringify(RX) };
    }
    if (payload.action === 'save') {
      if (Array.isArray(payload.newCatalogItems) && payload.newCatalogItems.length) {
        payload.newCatalogItems.forEach(function (it, idx) {
          var isLab = /^lab/i.test(String(it.tipo || '')) || (it.diseno && it.diseno !== 'Monofocal');
          var isExt = !isLab && /extend|rango/i.test(String(it.tipo || ''));
          demoExtraCatalog.push({
            codigo: 'DEMO-' + (demoExtraCatalog.length + idx + 1),
            nombre: it.nombre,
            tipo: isLab ? 'Laboratorio' : (isExt ? 'Rango Extendido' : 'Stock'),
            diseno: it.diseno || 'Monofocal',
            indice: it.indice || '1.50',
            tratamiento: it.tratamiento || '',
            esfMin: isLab ? -20 : (isExt ? -10 : -8),
            esfMax: isLab ? 14 : 6,
            cilMax: isLab ? 6 : (isExt ? 4 : 2),
            sumaMax: isLab ? 22 : (isExt ? 10 : 8),
            precioMedioPar: Number(it.precioMedioPar) || 0,
            activo: 'Sí'
          });
        });
      }
      var copy = Object.assign({}, payload, { image: '[' + (payload.image || '').length + ' chars]' });
      console.info('[DEMO] payload que se enviaría al backend:', copy);
      var existed = Boolean(payload.uuid && demoSavedUuids[payload.uuid]);
      if (payload.uuid) demoSavedUuids[payload.uuid] = true;
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      var stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' +
        p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      var nowStr = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
        p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      var stageMap = { incompleto: 'INCOMPLETO', abandonado: 'ABANDONADO', anulado: 'ANULADO', presupuestado: 'PRESUPUESTADO' };
      var stLabel = stageMap[payload.stage] || (payload.closure && payload.closure.sold ? 'VENTA CONCRETADA' : (payload.stage === 'cerrado' ? 'NO CONCRETADA' : 'PRESUPUESTADO'));
      var existing = demoBudgets.find(function (b) { return b.uuid === payload.uuid; });
      if (existing) {
        existing.fecha = nowStr;
        existing.estado = stLabel;
        if (Array.isArray(payload.quoteItems) && payload.quoteItems.length) existing.options = payload.quoteItems;
      } else if (payload.uuid) {
        var extraObj = {};
        (payload.extraFields || []).forEach(function (ef) {
          var mapKey = { 'Nombre cliente': 'nombre', 'DNI': 'dni', 'Teléfono': 'telefono', 'Email cliente': 'email', 'Convenio': 'convenio', 'Cuál Convenio': 'convenio_otro', 'Derivación': 'derivacion', 'Nombre Doctor': 'derivacion_doctor', 'Nombre Secretaria': 'derivacion_secretaria', 'Origen': 'origen', 'Nombre Recomendador': 'origen_nombre', 'Red Social': 'origen_red', 'Notas': 'notas', 'Vendedor': 'vendedor' }[ef.label];
          if (mapKey) extraObj[mapKey] = String(ef.value || '');
        });
        demoBudgets.unshift({
          uuid: payload.uuid,
          fecha: nowStr,
          estado: stLabel,
          nombre: payload.photoName || extraObj.nombre || 'Demo',
          dni: extraObj.dni || (payload.rx && payload.rx.dni) || '',
          fotoUrl: '',
          rx: payload.rx || {},
          extras: payload.extras || [],
          extraMap: extraObj,
          options: payload.quoteItems || []
        });
      }
      var name = String(payload.photoName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sin-nombre';
      return {
        ok: true,
        fila: 42,
        fotoUrl: '',
        fotoNombre: stamp + '_' + name + '.jpg',
        estado: stLabel,
        updated: existed,
        demo: true
      };
    }
    return { ok: false, code: 400, error: 'Acción desconocida' };
  }

  var api = { handle: handle, mockFields: mockFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mock = api;
})(typeof window !== 'undefined' ? window : this);
