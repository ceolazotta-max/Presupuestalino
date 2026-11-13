# Presupuestalino

Aplicación web (PWA) alojada en GitHub Pages para fotografiar recetas ópticas manuscritas, extraer sus datos mediante OCR (Gemini), revisarlos/corregirlos en pantalla y guardar la foto en Google Drive junto con una nueva fila en un Google Sheets existente.

## Estructura

- `web/` — Frontend PWA estático (HTML/CSS/JS vanilla, listo para GitHub Pages).
- `apps-script/` — Backend Google Apps Script (`Code.js`, `Logic.js`, `appsscript.json`).
- `tests/` — Tests unitarios con Node.js (`node:test`).
- `.github/workflows/pages.yml` — Despliegue automático de `web/` a GitHub Pages.
- `docs/SETUP.md` — Guía paso a paso para conectar Google Cloud, Apps Script, Drive y Sheets.
- `.gsd/` — Especificación (`SPEC.md`), roadmap (`ROADMAP.md`) y estado (`STATE.md`).

## Comandos locales

```bash
npm test    # Ejecuta los tests unitarios (Node 24+)
npm run serve  # Levanta web/ en http://localhost:8080 (modo demo si SCRIPT_URL está vacío)
```

## Documentación

- Especificación técnica y modelo de seguridad: [.gsd/SPEC.md](.gsd/SPEC.md)
- Guía de despliegue: [docs/SETUP.md](docs/SETUP.md)
