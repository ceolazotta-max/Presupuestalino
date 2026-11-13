/**
 * validate.js — Validaciones de valores ópticos (UX, lado cliente).
 * Retorna '' si OK, o mensaje de advertencia.
 */
(function (root) {
  function toNum(v) {
    var s = String(v).trim().replace(',', '.').replace(/^\+/, '');
    if (/^(plano|pl|n|neutro)$/i.test(s)) return 0;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function quarterStep(n) { return Math.abs(n * 4 - Math.round(n * 4)) < 1e-9; }

  function diopter(v, min, max) {
    var n = toNum(v);
    if (isNaN(n)) return 'No es un número';
    if (n < min || n > max) return 'Fuera de rango (' + min + ' a ' + max + ')';
    if (!quarterStep(n)) return 'Debería ir en pasos de 0.25';
    return '';
  }

  function validateRxValue(type, value) {
    if (value === null || value === undefined || String(value).trim() === '') return '';
    var v = String(value).trim();
    switch (type) {
      case 'esfera': return diopter(v, -30, 30);
      case 'cilindro': return diopter(v, -10, 10);
      case 'adicion': return diopter(v, 0.25, 4);
      case 'eje': {
        var n = toNum(v.replace(/°$/, ''));
        if (isNaN(n) || n !== Math.round(n)) return 'Debe ser entero';
        if (n < 0 || n > 180) return 'Fuera de rango (0 a 180)';
        return '';
      }
      case 'dip': {
        var parts = v.split('/').map(toNum);
        if (parts.some(isNaN)) return 'Formato: 62 o 31/31';
        var total = parts.length === 2 && parts[0] < 45 ? parts[0] + parts[1] : parts[0];
        if (total < 40 || total > 80) return 'Fuera de rango habitual (40 a 80 mm)';
        return '';
      }
      default: return '';
    }
  }

  var api = { validateRxValue: validateRxValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Validate = api;
})(typeof window !== 'undefined' ? window : this);
