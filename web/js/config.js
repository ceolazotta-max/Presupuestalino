/**
 * config.js — Configuración pública del frontend.
 * Nada de esto es secreto: la seguridad vive en el backend (Apps Script).
 */
window.APP_CONFIG = {
  // URL "/exec" del Web App de Apps Script. Vacío = modo demo.
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwZnIPQfs2xjWETYHpxD13hONoFr7uUHeHzKs_huyaoxI6M4_83Qz3tydz98-9SQt1oXQ/exec',

  // Client ID OAuth (tipo "Aplicación web"). Es público por diseño.
  OAUTH_CLIENT_ID: '55515524869-abco32dch8e9v54ftlj2th4tgr5pnacp.apps.googleusercontent.com',

  // Dominio Workspace (ej. 'optica.com.ar'). Solo preselecciona cuenta;
  // el backend es quien rechaza cuentas ajenas.
  ALLOWED_DOMAIN: '',

  // Campo del formulario usado para nombrar la foto en Drive.
  PHOTO_NAME_FIELD: 'nombre',

  // Formulario de datos adicionales. type: text | tel | email | textarea | select
  EXTRA_FIELDS: [
    { key: 'nombre', label: 'Nombre cliente', type: 'text', required: true, autocomplete: 'name' },
    { key: 'telefono', label: 'Teléfono', type: 'tel', required: true, autocomplete: 'tel' },
    { key: 'email', label: 'Email cliente', type: 'email', required: true, autocomplete: 'email' },
    {
      key: 'origen',
      label: '¿De dónde nos conoce?',
      type: 'select',
      required: true,
      options: ['Ya era cliente', 'Recomendación', 'Redes sociales', 'Calle']
    },
    {
      key: 'origen_quien',
      label: 'Quién',
      type: 'text',
      required: true,
      showWhen: { field: 'origen', value: 'Recomendación' }
    },
    {
      key: 'origen_cual',
      label: 'Cuál',
      type: 'text',
      required: true,
      showWhen: { field: 'origen', value: 'Redes sociales' }
    },
    { key: 'notas', label: 'Notas', type: 'textarea', required: true },
    {
      key: 'vendedor',
      label: 'Vendedor',
      type: 'select',
      required: true,
      options: ['Gabriel', 'Micaela', 'Yamila']
    }
  ],

  // Compresión de imagen en el cliente.
  MAX_IMAGE_SIDE: 1280,
  JPEG_QUALITY: 0.80,

  // Presupuestador (Paso 4).
  OPTICA_NAME: 'Óptica Cristalino',
  QUOTE_VALIDITY_DAYS: 7,
  PAYMENT_CONFIG: {
    cashDiscountPct: 10,
    transferSurchargePct: 0,
    cardPlans: [
      { cuotas: 1, surchargePct: 0 },
      { cuotas: 3, surchargePct: 15 },
      { cuotas: 6, surchargePct: 30 }
    ],
    cristalinoPlans: [
      { cuotas: 2, surchargePct: 12 },
      { cuotas: 3, surchargePct: 20 },
      { cuotas: 6, surchargePct: 42 }
    ]
  }
};

// Modo demo: sin backend configurado o con ?demo en la URL.
window.APP_CONFIG.isMock = !window.APP_CONFIG.SCRIPT_URL ||
  new URLSearchParams(location.search).has('demo');
