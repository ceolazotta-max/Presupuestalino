/**
 * config.js — Configuración pública del frontend.
 * Nada de esto es secreto: la seguridad vive en el backend (Apps Script).
 */
window.APP_CONFIG = {
  // URL "/exec" del Web App de Apps Script. Vacío = modo demo.
  SCRIPT_URL: '',

  // Client ID OAuth (tipo "Aplicación web"). Es público por diseño.
  OAUTH_CLIENT_ID: '',

  // Dominio Workspace (ej. 'optica.com.ar'). Solo preselecciona cuenta;
  // el backend es quien rechaza cuentas ajenas.
  ALLOWED_DOMAIN: '',

  // Campo del formulario usado para nombrar la foto en Drive.
  PHOTO_NAME_FIELD: 'nombre',

  // Formulario de datos adicionales. type: text | tel | email | textarea | select
  EXTRA_FIELDS: [
    { key: 'nombre', label: 'Nombre cliente', type: 'text', required: true, autocomplete: 'name' },
    { key: 'telefono', label: 'Teléfono', type: 'tel', autocomplete: 'tel' },
    { key: 'email', label: 'Email cliente', type: 'email', autocomplete: 'email' },
    { key: 'sucursal', label: 'Sucursal', type: 'text' },
    { key: 'notas', label: 'Notas', type: 'textarea' }
  ],

  // Compresión de imagen en el cliente.
  MAX_IMAGE_SIDE: 2000,
  JPEG_QUALITY: 0.85
};

// Modo demo: sin backend configurado o con ?demo en la URL.
window.APP_CONFIG.isMock = !window.APP_CONFIG.SCRIPT_URL ||
  new URLSearchParams(location.search).has('demo');
