# STATE

**Posición:** Fase 1 completa (incluye Paso 4 Presupuestador). Siguiente: Fase 2 (Despliegue real por el usuario).
**Última actualización:** 2026-11-16

## Decisiones clave
- Frontend: GitHub Pages (`web/`), PWA, vanilla JS (sin build).
- Backend: Apps Script Web App, acciones `catalog` / `ocr` / `save`.
- OCR: Gemini con salida JSON estructurada.
- Auth: GIS ID token + validación servidor (ver SPEC §13).
- Sheet: mapeo por encabezado en hoja principal + pestaña `Catalogo` autogenerada con 13 cristales semilla.
- Presupuestador: medio par (`OD` / `OI`), transposición a cilindro negativo, bloqueo estricto Stock vs Laboratorio, carga manual guardable en catálogo, Efectivo `-10%`, Transferencia, Tarjeta y Plan Cristalino, impresión/PDF e imagen PNG para WhatsApp.

## Wave 1–3 Summary

**Objective:** Completar prototipo v0 con flujo completo de 4 pasos (Foto → Revisar → Datos → Presupuesto → Guardar).

**Changes:**
- Wave 1 (`ca47a53`): `apps-script/Logic.js`, `web/js/validate.js`, `tests/logic.test.js`, `package.json`, `.gitignore`.
- Wave 2 (`89f89f6`, `3c2f5e4`, `64dc589`): backend `Code.js`, PWA `web/`, precarga nombre desde receta, origen condicional, vendedor desplegable y Paso 4 presupuestador (`web/js/quote.js` + catálogo + ficha imprimible/WhatsApp).
- Wave 3 (`5bfe61b`): `docs/SETUP.md`, `README.md`, actualización de `.gsd/ROADMAP.md`, `.gsd/SPEC.md` y `.gsd/STATE.md`.

**Verification:**
- `node --check` en `apps-script/*.js`, `web/js/*.js` y `web/sw.js`: OK (exit 0).
- `node --test tests/logic.test.js`: todos los tests unitarios pasan.

**Risks/Debt:**
- Faltan pruebas E2E reales contra Apps Script + OAuth + Gemini (Fase 2/3) y validación visual del Paso 4 en navegador mobile/desktop.
- Cargar precios reales en la pestaña `Catalogo` del Sheet tras ejecutar `setupCheck()`.
- En producción usar Gemini pago o Vertex AI (datos de salud, Ley 25.326).

**Next Wave TODO:**
- Crear o abrir Google Sheet en Drive, pegar `SHEET_ID` y `DRIVE_FOLDER_ID` en Script Properties y correr `setupCheck()` (ver `docs/SETUP.md`).
- Probar flujo completo en modo demo (`npm run serve`) y luego en Fase 3 con 10 recetas de prueba.
