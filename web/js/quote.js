/**
 * quote.js — Motor óptico, catálogo por medio par, validaciones y medios de pago.
 * Corre en navegador (window.Quote) y en Node (tests).
 */
(function (root) {
  'use strict';

  var TIER_RANK = { 'Stock': 1, 'Rango Extendido': 2, 'Laboratorio': 3 };

  var SEED_CATALOG = [
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

  var DEFAULT_PAYMENT_CONFIG = {
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

  var USO_TO_DISENO = {
    lejos: 'Monofocal',
    cerca: 'Monofocal',
    multifocal: 'Multifocal',
    bifocal: 'Bifocal',
    ocupacional: 'Ocupacional'
  };

  function round2(n) { return Math.round(n * 100) / 100; }

  function parseDiopter(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().replace(',', '.').replace(/^\+/, '');
    if (!s) return null;
    if (/^(plano|pl|n|neutro)$/i.test(s)) return 0;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return round2(Number(s));
  }

  function parseAxis(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().replace(/°$/, '');
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    return n >= 0 && n <= 180 ? n : null;
  }

  function fmtDiopter(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var v = round2(Number(n));
    if (Math.abs(v) < 1e-9) return '0.00';
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function fmtAxis(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(Number(n)) + '°';
  }

  /** Normaliza un ojo y transpone cilindro positivo a cilindro negativo (estándar laboratorio). */
  function normalizeEyeRx(rawEsf, rawCil, rawEje, rawAdd, rawPrisma) {
    var esf = parseDiopter(rawEsf);
    var cil = parseDiopter(rawCil);
    var eje = parseAxis(rawEje);
    var add = parseDiopter(rawAdd);
    var prisma = String(rawPrisma || '').trim();
    var hasPrisma = Boolean(prisma);
    var hasPower = esf !== null || cil !== null;
    var hasGrad = hasPower || (add !== null && add > 0) || hasPrisma;

    if (!hasPower) {
      return {
        rawEsf: esf, rawCil: cil, rawEje: eje,
        esf_t: null, cil_t: null, eje_t: null,
        absCil: 0, meridianoMax: 0, transposed: false,
        add: add, prisma: prisma, hasPrisma: hasPrisma, hasGrad: hasGrad
      };
    }

    var e = esf !== null ? esf : 0;
    var c = cil !== null ? cil : 0;
    var esf_t, cil_t, eje_t, transposed;
    if (c > 0) {
      esf_t = round2(e + c);
      cil_t = round2(-c);
      eje_t = eje !== null ? (((eje + 90) % 180) || 180) : null;
      transposed = true;
    } else {
      esf_t = round2(e);
      cil_t = round2(c);
      eje_t = eje;
      transposed = false;
    }
    var absCil = Math.abs(cil_t);
    var meridianoMax = Math.max(Math.abs(esf_t), Math.abs(round2(esf_t + cil_t)));
    return {
      rawEsf: esf, rawCil: cil, rawEje: eje,
      esf_t: esf_t, cil_t: cil_t, eje_t: eje_t,
      absCil: absCil, meridianoMax: meridianoMax, transposed: transposed,
      add: add, prisma: prisma, hasPrisma: hasPrisma, hasGrad: true
    };
  }

  function hasCercaRx(rx) {
    rx = rx || {};
    return ['cerca_od_esfera', 'cerca_od_cilindro', 'cerca_oi_esfera', 'cerca_oi_cilindro']
      .some(function (k) { return parseDiopter(rx[k]) !== null; });
  }

  function resolveEyeForUso(rx, eye, uso) {
    var add = parseDiopter(rx.adicion);
    if (uso === 'cerca') {
      var cEsf = parseDiopter(rx['cerca_' + eye + '_esfera']);
      var cCil = parseDiopter(rx['cerca_' + eye + '_cilindro']);
      if (cEsf !== null || cCil !== null) {
        return normalizeEyeRx(rx['cerca_' + eye + '_esfera'], rx['cerca_' + eye + '_cilindro'], rx['cerca_' + eye + '_eje'], add, rx.prisma);
      }
      var lEsf = parseDiopter(rx['lejos_' + eye + '_esfera']);
      var lCil = parseDiopter(rx['lejos_' + eye + '_cilindro']);
      if ((lEsf !== null || lCil !== null) && add !== null && add > 0) {
        return normalizeEyeRx(round2((lEsf || 0) + add), rx['lejos_' + eye + '_cilindro'], rx['lejos_' + eye + '_eje'], add, rx.prisma);
      }
      return normalizeEyeRx(null, null, null, null, rx.prisma);
    }
    return normalizeEyeRx(rx['lejos_' + eye + '_esfera'], rx['lejos_' + eye + '_cilindro'], rx['lejos_' + eye + '_eje'], add, rx.prisma);
  }

  /** Devuelve graduación efectiva normalizada para OD y OI según el uso elegido. */
  function resolveEffectiveRx(rx, uso) {
    rx = rx || {};
    uso = uso || inferDefaultUso(rx);
    return {
      uso: uso,
      od: resolveEyeForUso(rx, 'od', uso),
      oi: resolveEyeForUso(rx, 'oi', uso),
      dip: String(rx.dip || '').trim(),
      add: parseDiopter(rx.adicion),
      prisma: String(rx.prisma || '').trim(),
      hasPrisma: Boolean(rx.prisma && String(rx.prisma).trim())
    };
  }

  function inferDefaultUso(rx) {
    rx = rx || {};
    var tipo = String(rx.tipo_lente || '').toLowerCase();
    if (/multifocal|progresivo/.test(tipo)) return 'multifocal';
    if (/bifocal/.test(tipo)) return 'bifocal';
    if (/ocupacional|degresivo/.test(tipo)) return 'ocupacional';
    var add = parseDiopter(rx.adicion);
    var hasLejos = ['lejos_od_esfera', 'lejos_od_cilindro', 'lejos_oi_esfera', 'lejos_oi_cilindro']
      .some(function (k) { return parseDiopter(rx[k]) !== null; });
    if (add !== null && add > 0) return 'multifocal';
    if (!hasLejos && hasCercaRx(rx)) return 'cerca';
    return 'lejos';
  }

  function getEyeMinTier(eyeRx, uso) {
    if (['multifocal', 'bifocal', 'ocupacional'].indexOf(uso) >= 0) {
      return { tipo: 'Laboratorio', rank: 3, reason: 'Diseño ' + uso + ' requiere Laboratorio' };
    }
    if (eyeRx && eyeRx.hasPrisma) {
      return { tipo: 'Laboratorio', rank: 3, reason: 'Receta con prisma requiere Laboratorio' };
    }
    if (!eyeRx || !eyeRx.hasGrad || eyeRx.esf_t === null) {
      return { tipo: 'Stock', rank: 1, reason: '' };
    }
    if (eyeRx.absCil > 4.00 || eyeRx.esf_t < -10.00 || eyeRx.esf_t > 6.00 || eyeRx.meridianoMax > 10.00) {
      return { tipo: 'Laboratorio', rank: 3, reason: 'Graduación de Laboratorio' };
    }
    if (eyeRx.absCil > 2.00 || eyeRx.esf_t < -8.00 || eyeRx.esf_t > 6.00 || eyeRx.meridianoMax > 8.00) {
      return { tipo: 'Rango Extendido', rank: 2, reason: 'Cilindro/esfera requiere Rango Extendido o Lab' };
    }
    return { tipo: 'Stock', rank: 1, reason: '' };
  }

  function canEyeUseStock(eyeRx, uso) {
    var minTier = getEyeMinTier(eyeRx, uso);
    return { ok: minTier.rank === 1, reason: minTier.reason };
  }

  function checkProductForEye(product, eyeRx, uso, requiredTierRank) {
    if (!product) return { allowed: false, reason: 'Sin producto seleccionado' };
    var expectedDesign = USO_TO_DISENO[uso || 'lejos'];
    if (expectedDesign && product.diseno && product.diseno !== expectedDesign) {
      return { allowed: false, reason: 'Diseño ' + product.diseno + ' no coincide con uso ' + uso };
    }
    var prodRank = TIER_RANK[product.tipo] || 1;
    var eyeMin = getEyeMinTier(eyeRx, uso);
    if (prodRank < eyeMin.rank) {
      return { allowed: false, reason: eyeMin.reason };
    }
    if (requiredTierRank && prodRank < requiredTierRank) {
      var reqName = requiredTierRank === 3 ? 'Laboratorio' : 'Rango Extendido o Laboratorio';
      return { allowed: false, reason: 'Requiere nivel ' + reqName };
    }
    if (product.tipo === 'Stock' || product.tipo === 'Rango Extendido') {
      if (eyeRx && eyeRx.hasGrad && eyeRx.esf_t !== null) {
        if (eyeRx.esf_t < product.esfMin || eyeRx.esf_t > product.esfMax) {
          return {
            allowed: false,
            reason: 'Esfera ' + fmtDiopter(eyeRx.esf_t) + ' fuera de rango (' + fmtDiopter(product.esfMin) + ' a ' + fmtDiopter(product.esfMax) + ')'
          };
        }
        if (eyeRx.absCil > product.cilMax) {
          return {
            allowed: false,
            reason: 'Cilindro ' + fmtDiopter(eyeRx.cil_t) + ' supera máx ' + fmtDiopter(-product.cilMax)
          };
        }
        var sumaMax = Number(product.sumaMax) || Math.max(Math.abs(product.esfMin), Math.abs(product.esfMax));
        var sumAbs = Math.abs(round2(eyeRx.esf_t + (eyeRx.cil_t || 0)));
        if (sumAbs > sumaMax || eyeRx.meridianoMax > sumaMax) {
          return {
            allowed: false,
            reason: 'Meridiano ' + sumAbs.toFixed(2) + ' supera suma máx ' + sumaMax.toFixed(2)
          };
        }
      }
    }
    return { allowed: true, reason: '' };
  }

  function resolveEyeProduct(sel, catalog) {
    if (!sel) return null;
    if (sel.mode === 'manual') {
      var m = sel.manual || {};
      var mTipo = m.tipo || 'Stock';
      var isLab = mTipo === 'Laboratorio';
      var isExt = mTipo === 'Rango Extendido';
      return {
        codigo: 'MANUAL',
        nombre: String(m.nombre || '').trim(),
        tipo: mTipo,
        diseno: m.diseno || 'Monofocal',
        indice: m.indice || '',
        tratamiento: m.tratamiento || '',
        esfMin: isLab ? -20 : (isExt ? -10 : -8),
        esfMax: isLab ? 14 : 6,
        cilMax: isLab ? 6 : (isExt ? 4 : 2),
        sumaMax: isLab ? 22 : (isExt ? 10 : 8),
        precioMedioPar: Number(sel.price != null ? sel.price : m.precio) || 0,
        isManual: true,
        saveToCatalog: Boolean(m.saveToCatalog)
      };
    }
    if (sel.product) return sel.product;
    if (sel.codigo && Array.isArray(catalog)) {
      return catalog.find(function (p) { return p.codigo === sel.codigo; }) || null;
    }
    return null;
  }

  function checkProductForPair(product, effOd, effOi, uso) {
    if (!product) return { allowed: false, reason: 'Sin producto seleccionado' };
    var pairRank = Math.max(getEyeMinTier(effOd, uso).rank, getEyeMinTier(effOi, uso).rank);
    var chkOd = checkProductForEye(product, effOd, uso, pairRank);
    if (!chkOd.allowed) return chkOd;
    return checkProductForEye(product, effOi, uso, pairRank);
  }

  function sameManualProduct(a, b) {
    var ma = (a && a.manual) || {};
    var mb = (b && b.manual) || {};
    return normText(ma.nombre) === normText(mb.nombre) &&
      (ma.tipo || 'Stock') === (mb.tipo || 'Stock') &&
      (ma.diseno || 'Monofocal') === (mb.diseno || 'Monofocal') &&
      String(ma.indice || '') === String(mb.indice || '') &&
      normText(ma.tratamiento) === normText(mb.tratamiento);
  }

  function areSameEyeProduct(selOd, selOi, prodOd, prodOi) {
    if (!prodOd || !prodOi) return false;
    var mOd = (selOd && selOd.mode) || 'catalog';
    var mOi = (selOi && selOi.mode) || 'catalog';
    if (mOd !== mOi) return false;
    if (mOd === 'manual') return sameManualProduct(selOd, selOi);
    if (selOd && selOd.codigo && selOi && selOi.codigo) return selOd.codigo === selOi.codigo;
    return normText(prodOd.nombre) === normText(prodOi.nombre);
  }

  function normText(s) { return String(s || '').trim().toLowerCase(); }

  function validateQuote(rx, quoteState, catalog) {
    quoteState = quoteState || {};
    var uso = quoteState.uso || 'lejos';
    var eyesMode = quoteState.eyesMode || 'both';
    var eff = resolveEffectiveRx(rx, uso);
    var errors = [];
    var warnings = [];

    if (['multifocal', 'bifocal', 'ocupacional'].indexOf(uso) >= 0) {
      if (!(eff.add !== null && eff.add > 0) && !hasCercaRx(rx)) {
        errors.push('Uso ' + uso + ' sin Adición ni graduación de Cerca en la receta.');
      }
    }
    if (uso === 'cerca' && !eff.od.hasGrad && !eff.oi.hasGrad) {
      errors.push('Uso Cerca sin graduación de cerca ni Adición en la receta.');
    }

    var includeOd = eyesMode !== 'oi';
    var includeOi = eyesMode !== 'od';
    var prodOd = includeOd ? resolveEyeProduct(quoteState.od, catalog) : null;
    var prodOi = includeOi ? resolveEyeProduct(quoteState.oi, catalog) : null;
    var reqRank = (includeOd && includeOi)
      ? Math.max(getEyeMinTier(eff.od, uso).rank, getEyeMinTier(eff.oi, uso).rank)
      : (includeOd ? getEyeMinTier(eff.od, uso).rank : getEyeMinTier(eff.oi, uso).rank);

    [
      { inc: includeOd, label: 'OD', sel: quoteState.od, prod: prodOd, eyeRx: eff.od },
      { inc: includeOi, label: 'OI', sel: quoteState.oi, prod: prodOi, eyeRx: eff.oi }
    ].forEach(function (e) {
      if (!e.inc) return;
      if (!e.prod || !e.prod.nombre) {
        errors.push('Falta seleccionar cristal para ½ par ' + e.label + '.');
        return;
      }
      var chk = checkProductForEye(e.prod, e.eyeRx, uso, reqRank);
      if (!chk.allowed) errors.push(e.label + ': ' + chk.reason);
      var price = Number(e.sel && e.sel.price != null ? e.sel.price : e.prod.precioMedioPar);
      if (!(price > 0)) errors.push('Falta precio válido para ½ par ' + e.label + '.');
    });

    if (includeOd && includeOi && prodOd && prodOi && prodOd.nombre && prodOi.nombre) {
      if (prodOd.tipo !== prodOi.tipo) {
        errors.push('Ambos ojos deben tener el mismo rango (' + prodOd.tipo + ' vs ' + prodOi.tipo + ').');
      } else if (!areSameEyeProduct(quoteState.od, quoteState.oi, prodOd, prodOi)) {
        errors.push('En Ambos ojos, el cristal de OD y OI debe coincidir exactamente.');
      }
      if (prodOd.indice && prodOi.indice && prodOd.indice !== prodOi.indice) {
        warnings.push('Asimetría de índice entre ojos (OD ' + prodOd.indice + ' vs OI ' + prodOi.indice + ').');
      }
      if (normText(prodOd.tratamiento) !== normText(prodOi.tratamiento)) {
        warnings.push('Asimetría de tratamiento entre ojos (OD: ' + (prodOd.tratamiento || '—') + ' vs OI: ' + (prodOi.tratamiento || '—') + ').');
      }
    }

    var frame = quoteState.frame || {};
    if (frame.mode === 'nuevo') {
      if (!String(frame.marca || '').trim()) errors.push('Falta completar Marca del armazón.');
      if (!String(frame.modelo || '').trim()) errors.push('Falta completar Modelo del armazón.');
      if (!String(frame.color || '').trim()) errors.push('Falta completar Color del armazón.');
      if (!(Number(frame.price) > 0)) errors.push('Falta precio válido para el armazón.');
    }
    var rim = frame.rimType || 'completo';
    [
      { inc: includeOd, label: 'OD', prod: prodOd, eyeRx: eff.od },
      { inc: includeOi, label: 'OI', prod: prodOi, eyeRx: eff.oi }
    ].forEach(function (e) {
      if (!e.inc || !e.prod) return;
      if (e.prod.indice === '1.50' && (e.eyeRx.meridianoMax >= 4.00 || e.eyeRx.absCil >= 2.25)) {
        warnings.push(e.label + ': graduación alta con índice 1.50. Sugerido 1.59 o 1.67 para menor espesor.');
      }
      if (e.prod.indice === '1.50' && (rim === 'semi' || rim === 'aire')) {
        warnings.push(e.label + ': armazón ' + (rim === 'aire' ? 'al aire' : 'ranurado/tanza') + ' con índice 1.50 tiene riesgo de astillado. Conviene 1.59 o 1.67.');
      }
    });

    var highPower = (includeOd && eff.od.meridianoMax >= 3.00) || (includeOi && eff.oi.meridianoMax >= 3.00);
    if (!eff.dip && (['multifocal', 'ocupacional'].indexOf(uso) >= 0 || highPower)) {
      warnings.push('Falta registrar DIP en la receta.');
    }

    return { errors: errors, warnings: warnings };
  }

  function nonNeg(n) {
    var x = Number(n);
    return isFinite(x) && x > 0 ? Math.round(x) : 0;
  }

  function buildPlans(base, plans) {
    return (plans || []).map(function (p) {
      var cuotas = Math.max(1, Number(p.cuotas) || 1);
      var pct = Number(p.surchargePct) || 0;
      var total = Math.round(base * (1 + pct / 100));
      return {
        marca: p.marca ? String(p.marca) : '',
        plan: p.plan ? String(p.plan) : (cuotas === 1 ? '1 cuota' : cuotas + ' cuotas'),
        cuotas: cuotas,
        surchargePct: pct,
        total: total,
        cuotaMensual: Math.round(total / cuotas)
      };
    });
  }

  /** Agrupa opciones de tarjeta por marca/banco preservando el orden configurado. */
  function groupCardPlans(cardOptions) {
    var groups = [];
    var byBrand = {};
    (cardOptions || []).forEach(function (opt) {
      var marca = opt.marca || 'General';
      if (!byBrand[marca]) {
        byBrand[marca] = { marca: marca, options: [] };
        groups.push(byBrand[marca]);
      }
      byBrand[marca].options.push(opt);
    });
    return groups;
  }

  function calculateTotals(quoteState, paymentCfg) {
    quoteState = quoteState || {};
    var cfg = Object.assign({}, DEFAULT_PAYMENT_CONFIG, paymentCfg || {});
    var eyesMode = quoteState.eyesMode || 'both';
    var rawOdPrice = eyesMode === 'oi' ? 0 : nonNeg(quoteState.od && quoteState.od.price);
    var rawOiPrice = eyesMode === 'od' ? 0 : nonNeg(quoteState.oi && quoteState.oi.price);
    var odPrice = rawOdPrice;
    var oiPrice = rawOiPrice;
    if (eyesMode === 'both') {
      var pairUnit = Math.max(rawOdPrice, rawOiPrice);
      odPrice = pairUnit;
      oiPrice = pairUnit;
    }
    var frameMode = (quoteState.frame && quoteState.frame.mode) || 'none';
    var framePrice = frameMode === 'nuevo' ? nonNeg(quoteState.frame && quoteState.frame.price) : 0;
    var subtotal = odPrice + oiPrice + framePrice;
    var discountAmount = Math.min(subtotal, nonNeg(quoteState.discount));
    var listTotal = Math.max(0, subtotal - discountAmount);
    var depositAmount = Math.min(listTotal, nonNeg(quoteState.deposit));
    var balanceBase = Math.max(0, listTotal - depositAmount);

    var cashTotal = Math.round(balanceBase * (1 - (Number(cfg.cashDiscountPct) || 0) / 100));
    var transferTotal = Math.round(balanceBase * (1 + (Number(cfg.transferSurchargePct) || 0) / 100));
    return {
      odPrice: odPrice,
      oiPrice: oiPrice,
      rawOdPrice: rawOdPrice,
      rawOiPrice: rawOiPrice,
      framePrice: framePrice,
      subtotal: subtotal,
      discountAmount: discountAmount,
      listTotal: listTotal,
      depositAmount: depositAmount,
      balanceBase: balanceBase,
      cashDiscountPct: Number(cfg.cashDiscountPct) || 0,
      transferSurchargePct: Number(cfg.transferSurchargePct) || 0,
      cashTotal: cashTotal,
      transferTotal: transferTotal,
      cardOptions: buildPlans(balanceBase, cfg.cardPlans),
      cardGroups: groupCardPlans(buildPlans(balanceBase, cfg.cardPlans)),
      cristalinoOptions: buildPlans(balanceBase, cfg.cristalinoPlans)
    };
  }

  function fmtMoney(n) {
    return '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');
  }

  function sortProductsByPriceDesc(list) {
    return (list || []).slice().sort(function (a, b) {
      var diff = (Number(b && b.precioMedioPar) || 0) - (Number(a && a.precioMedioPar) || 0);
      if (diff !== 0) return diff;
      return String((a && a.nombre) || '').localeCompare(String((b && b.nombre) || ''));
    });
  }

  var api = {
    TIER_RANK: TIER_RANK,
    SEED_CATALOG: SEED_CATALOG,
    DEFAULT_PAYMENT_CONFIG: DEFAULT_PAYMENT_CONFIG,
    USO_TO_DISENO: USO_TO_DISENO,
    parseDiopter: parseDiopter,
    parseAxis: parseAxis,
    fmtDiopter: fmtDiopter,
    fmtAxis: fmtAxis,
    fmtMoney: fmtMoney,
    sortProductsByPriceDesc: sortProductsByPriceDesc,
    normalizeEyeRx: normalizeEyeRx,
    resolveEffectiveRx: resolveEffectiveRx,
    inferDefaultUso: inferDefaultUso,
    getEyeMinTier: getEyeMinTier,
    canEyeUseStock: canEyeUseStock,
    checkProductForEye: checkProductForEye,
    checkProductForPair: checkProductForPair,
    areSameEyeProduct: areSameEyeProduct,
    resolveEyeProduct: resolveEyeProduct,
    validateQuote: validateQuote,
    calculateTotals: calculateTotals
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quote = api;
})(typeof window !== 'undefined' ? window : this);
