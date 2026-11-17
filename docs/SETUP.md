# Guía de despliegue y pruebas — Presupuestalino

## 1. Probar en modo Demo (sin backend)

Si `SCRIPT_URL` en `web/js/config.js` está vacío (o agregando `?demo` a la URL), la app corre con datos simulados sin enviar ni guardar nada.

```bash
npm run serve
```

Abrí `http://localhost:8080` en el navegador (o en GitHub Pages una vez publicado).

---

## 2. Preparar Drive y Google Sheets

1. Creá una carpeta en **Google Drive** corporativo para guardar las fotos de recetas.
   - Copiá su ID de la URL: `https://drive.google.com/drive/folders/<DRIVE_FOLDER_ID>`.
2. Abrí el **Google Sheet** existente (o creá uno nuevo en blanco en Google Drive).
   - Copiá su ID de la URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.
   - Dejá ambos recursos compartidos solo con el dueño del script y el equipo autorizado.
   - No hace falta armar columnas a mano: al ejecutar `setupCheck` (paso 5.4), el script crea automáticamente la pestaña **`Catalogo`** con 13 cristales base (para que completes precios reales en `Precio_Medio_Par`) y al guardar la primera receta crea los encabezados de la hoja principal.

---

## 3. Configurar Google Cloud y OAuth

1. Creá el proyecto **Presupuestalino** en [Google Cloud Console](https://console.cloud.google.com/):
   - Hacé clic en el **selector de proyecto** (botón arriba a la izquierda, junto al logo de Google Cloud, donde figura el nombre del proyecto actual).
   - En la ventana emergente, tocá **Proyecto nuevo** (arriba a la derecha).
   - En **Nombre del proyecto**, escribí `Presupuestalino` (Organización: *Sin organización* si usás `@gmail.com`) y tocá **Crear**.
   - Cuando termine de crearse (notificación arriba a la derecha), hacé clic en **Seleccionar proyecto** y verificá que en la pantalla diga **`Estás trabajando en Presupuestalino`**.
2. Abrí **APIs y servicios** (tarjeta en *Acceso rápido*) → **Pantalla de consentimiento de OAuth** (o **Google Auth Platform → Público**):
   - **Si usás Google Workspace con dominio propio:** elegí **Interno (Internal)**. Esto limita el acceso solo a cuentas de tu dominio.
   - **Si usás cuentas `@gmail.com` comunes (ej. tu captura actual):** Google Cloud muestra **Usuarios externos** en estado **"Prueba"**. Dejalo en **Prueba** (no lo publiques) y agregá las cuentas autorizadas en **Usuarios de prueba → `+ Add users`** (ej. los emails de tus vendedores). Así Google bloquea cualquier otra cuenta antes de emitir token.
   - Completá nombre de la app y emails de contacto.
3. En **Clientes / Credenciales → Crear cliente → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - **Orígenes de JavaScript autorizados**:
     - `https://<usuario-u-org>.github.io` (sin barra final ni ruta del repo)
     - `http://localhost:8080` (opcional, para pruebas locales)
   - Copiá el **ID de cliente** (`...apps.googleusercontent.com`).

---

## 4. API Key de Gemini

### A. Fase de pruebas (Nivel gratuito — solo recetas ficticias o anonimizadas)
1. Ingresá a [Google AI Studio — Claves de API](https://aistudio.google.com/apikey) con la misma cuenta de Google.
2. Tocá el botón **Importar proyectos** (en el centro) y seleccioná el proyecto de Google Cloud que creaste en el paso 3 *(así queda todo ordenado bajo un mismo proyecto)*.
3. Tocá **Crear clave de API** (arriba a la derecha), asignale un nombre (ej. `Presupuestalino`) y elegí el proyecto importado.
   *(Si es solo para probar rápido, también podés crearla en el proyecto por defecto o copiar una clave existente con el ícono de copiar en la columna de acciones).*
4. Copiá la clave generada y guardala aparte para pegarla en `GEMINI_API_KEY` en el paso 5.3 *(nunca la pegues en `config.js` ni la subas a GitHub)*.
5. ⚠️ **Prohibido subir recetas reales** mientras figure **Nivel gratuito**: Google puede usar las fotos para entrenar modelos.

### B. Paso a Producción (datos reales de salud, Ley 25.326)
1. En la misma tabla de **Claves de API**, en la columna **Nivel de facturación**, hacé clic en **Configurar la facturación** junto a tu proyecto y vinculá una tarjeta en Google Cloud (**Pay-as-you-go**). Cuando cambia a nivel pago, Google deja de usar los datos para entrenamiento. *(Alternativa: Vertex AI).*
2. En [Google Cloud Billing](https://console.cloud.google.com/billing) → **Presupuestos y alertas**, creá un presupuesto mensual (ej. USD 5) con alertas al 50 %, 90 % y 100 %.

---

## 5. Crear y desplegar el Backend en Apps Script

1. Con la cuenta corporativa dueña de la carpeta y el Sheet, abrí [script.google.com](https://script.google.com/) → **Nuevo proyecto**.
2. Cargá los archivos del repositorio:
   - Renombrá/editá `Code.gs` y pegá el contenido de `apps-script/Code.js`.
   - Creá un archivo de secuencia de comandos llamado `Logic` (`Logic.gs`) y pegá `apps-script/Logic.js`.
   - En **Configuración del proyecto** marcá *Mostrar el archivo de manifiesto "appsscript.json" en el editor* y pegá `apps-script/appsscript.json`.
3. En **Configuración del proyecto → Propiedades de la secuencia de comandos (Script Properties)** agregá:

| Propiedad | Obligatoria | Descripción / Ejemplo |
|---|---|---|
| `GEMINI_API_KEY` | Sí | Clave de Gemini API |
| `OAUTH_CLIENT_ID` | Sí | Client ID web de Google Cloud |
| `ALLOWED_DOMAIN` | Si usás Workspace | Dominio corporativo, ej. `mioptica.com.ar`. **Dejar vacío si usás cuentas `@gmail.com`** |
| `SHEET_ID` | Sí | ID del Google Sheet |
| `DRIVE_FOLDER_ID` | Sí | ID de la carpeta de Drive |
| `ALLOWED_EMAILS` | Sí con `@gmail.com` | Lista separada por comas de emails autorizados (ej. `ceo.lazotta@gmail.com,vendedor@gmail.com`) |
| `SHEET_NAME` | Opcional | Nombre de la pestaña (default: primera hoja) |
| `GEMINI_MODEL` | Opcional | Default: `gemini-flash-latest` |
| `RATE_OCR_PER_HOUR` | Opcional | Default: `30` |
| `RATE_SAVE_PER_HOUR` | Opcional | Default: `30` |
| `TIMEZONE` | Opcional | Default: `America/Argentina/Buenos_Aires` |

4. En el editor seleccioná la función `setupCheck` y tocá **Ejecutar**. Aceptá los permisos de Drive, Sheets y URL Fetch, y verificá en los registros que todo figure `OK` / `HTTP 200`.
5. Tocá **Implementar → Nueva implementación**:
   - Tipo: **Aplicación web**.
   - Ejecutar como: **Yo**.
   - Quién tiene acceso: **Cualquier persona** (necesario para CORS; la autenticación real la valida `Code.gs` con el ID token en cada pedido).
   - Copiá la URL terminada en `/exec`.

---

## 6. Conectar el Frontend y publicar en GitHub Pages

1. Editá `web/js/config.js` con los valores públicos:
   - `SCRIPT_URL`: la URL `/exec` de Apps Script.
   - `OAUTH_CLIENT_ID`: el Client ID creado en el paso 3.
   - `ALLOWED_DOMAIN`: tu dominio corporativo (ej. `'mioptica.com.ar'`), o `''` vacío si usás cuentas `@gmail.com`.
   - *(Ninguno de estos tres datos es secreto).*
2. Hacé commit y push al repositorio en GitHub.
3. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. El workflow `.github/workflows/pages.yml` publicará automáticamente la carpeta `web/`.
