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

## 3. Configurar Google Cloud y OAuth Interno

1. Ingresá a [Google Cloud Console](https://console.cloud.google.com/) con la cuenta corporativa y creá o elegí un proyecto.
2. En **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Elegí tipo de usuario **Interno (Internal)**. Esto bloquea el login para cuentas `@gmail.com` o externas antes de que lleguen a la app.
   - Completá nombre de la app y emails de contacto.
3. En **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - **Orígenes de JavaScript autorizados**:
     - `https://<usuario-u-org>.github.io` (sin barra final ni ruta del repo)
     - `http://localhost:8080` (opcional, para pruebas locales)
   - Copiá el **ID de cliente** (`...apps.googleusercontent.com`).

---

## 4. API Key de Gemini

- **Fase de pruebas (solo recetas ficticias o anonimizadas):**
  - Generá una API key en [Google AI Studio](https://aistudio.google.com/apikey) (capa gratuita).
  - ⚠️ **Prohibido subir recetas reales** en capa gratuita: Google puede usar los datos para entrenar modelos.
- **Producción (datos reales de salud, Ley 25.326):**
  - Vinculá facturación en Google Cloud (**Pay-as-you-go**) o usá **Vertex AI**, donde los datos no se usan para entrenamiento.
  - Configurá alertas y límite de presupuesto en Google Cloud Billing.

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
| `ALLOWED_DOMAIN` | Sí | Dominio Workspace, ej. `mioptica.com.ar` |
| `SHEET_ID` | Sí | ID del Google Sheet |
| `DRIVE_FOLDER_ID` | Sí | ID de la carpeta de Drive |
| `ALLOWED_EMAILS` | Opcional | Lista separada por comas de emails autorizados |
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
   - `ALLOWED_DOMAIN`: tu dominio corporativo (ej. `'mioptica.com.ar'`).
   - *(Ninguno de estos tres datos es secreto).*
2. Hacé commit y push al repositorio en GitHub.
3. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. El workflow `.github/workflows/pages.yml` publicará automáticamente la carpeta `web/`.
