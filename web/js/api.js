/**
 * api.js — Cliente del backend (Apps Script) o mock en modo demo.
 */
window.Api = (function () {
  var C = window.APP_CONFIG;

  function ApiError(message, code) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.code = code;
    return e;
  }

  async function call(payload, timeoutMs) {
    if (C.isMock) {
      var r = await window.Mock.handle(payload);
      if (!r.ok) throw ApiError(r.error, r.code);
      return r;
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 90000);
    try {
      // text/plain evita el preflight CORS (Apps Script no responde OPTIONS).
      var res = await fetch(C.SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!res.ok) throw ApiError('Error del servidor (HTTP ' + res.status + ')', res.status);
      var data = await res.json();
      if (!data.ok) throw ApiError(data.error || 'Error desconocido', data.code);
      return data;
    } catch (e) {
      if (e.name === 'ApiError') throw e;
      if (e.name === 'AbortError') throw ApiError('El servidor tardó demasiado. Reintentá.', 408);
      throw ApiError('Sin conexión con el servidor. Revisá internet y reintentá.', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    catalog: function (idToken) { return call({ action: 'catalog', idToken: idToken }, 30000); },
    ocr: function (idToken, image) { return call({ action: 'ocr', idToken: idToken, image: image }, 120000); },
    save: function (p) { return call(Object.assign({ action: 'save' }, p), 90000); }
  };
})();
