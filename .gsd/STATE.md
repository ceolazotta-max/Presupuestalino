# STATE

**Posición:** Fase 1 completa (Waves 1, 2 y 3 cerradas). Siguiente: Fase 2 (Despliegue real por el usuario).
**Última actualización:** 2026-11-13

## Decisiones clave
- Frontend: GitHub Pages (`web/`), PWA, vanilla JS (sin build).
- Backend: Apps Script Web App, acción `ocr` / `save`.
- OCR: Gemini con salida JSON estructurada.
- Auth: GIS ID token + validación servidor (ver SPEC §13).
- Sheet: mapeo por encabezado.

## Wave 1–3 Summary

**Objective:** Completar prototipo v0 (lógica compartida, backend Apps Script, frontend PWA con modo demo, workflow de GitHub Pages, tests y guía de setup).

**Changes:**
- Wave 1 (`ca47a53`): `apps-script/Logic.js`, `web/js/validate.js`, `tests/logic.test.js`, `package.json`, `.gitignore`.
- Wave 2 (`89f89f6` + `3c2f5e4`): `apps-script/Code.js`, `apps-script/appsscript.json`, `web/index.html`, `web/css/styles.css`, `web/js/config.js`, `web/js/mock.js`, `web/js/api.js`, `web/js/app.js`, `web/manifest.webmanifest`, `web/sw.js`, `web/icons/icon.svg`, `web/icons/icon-192.png`, `.github/workflows/pages.yml`, ampliación de `tests/logic.test.js`.
- Wave 3: `docs/SETUP.md`, `README.md`, actualización de `.gsd/ROADMAP.md` y `.gsd/STATE.md`.

**Files Touched:**
- `apps-script/Code.js`, `apps-script/Logic.js`, `apps-script/appsscript.json`
- `web/` (`index.html`, `manifest.webmanifest`, `sw.js`, `css/styles.css`, `icons/*`, `js/*`)
- `.github/workflows/pages.yml`, `tests/logic.test.js`, `docs/SETUP.md`, `README.md`, `package.json`, `.gitignore`
- `.gsd/SPEC.md`, `.gsd/ROADMAP.md`, `.gsd/STATE.md`

**Verification:**
- `node --check` en `apps-script/*.js`, `web/js/*.js` y `web/sw.js`: OK (exit 0).
- `node --test tests/logic.test.js`: 13/13 tests pass.

**Risks/Debt:**
- Faltan pruebas E2E reales contra Apps Script + OAuth + Gemini (Fase 2/3) y captura visual en mobile/desktop.
- Ajustar `RX_SCHEMA` / `EXTRA_FIELDS` según 3–5 recetas ficticias o anonimizadas reales de la óptica.
- En producción usar Gemini pago o Vertex AI (datos de salud, Ley 25.326).

**Next Wave TODO:**
- Seguir `docs/SETUP.md` para configurar Google Cloud (OAuth Internal), Script Properties y publicar en GitHub Pages.
- Correr `setupCheck()` en Apps Script y probar flujo completo con 10 recetas de prueba (Fase 3).
