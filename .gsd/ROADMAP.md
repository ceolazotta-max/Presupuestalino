# ROADMAP — Presupuestalino

| Fase | Objetivo | Estado |
|---|---|---|
| 0 | SPEC finalizado + roadmap | ✅ |
| 1 | Prototipo v0 (código) | 🔄 |
| 2 | Despliegue real (Apps Script + GitHub Pages + OAuth) por el usuario | ⏳ |
| 3 | Prueba con 10 recetas ficticias, medir AC-03, ajustar prompt/schema | ⏳ |
| 4 | Hardening producción (Gemini pago/Vertex, revisión legal) | ⏳ |

## Fase 1 — Waves

| Wave | Tareas | Depende |
|---|---|---|
| 1 | Lógica pura compartida (`apps-script/Logic.gs`) + tests Node | — |
| 2 | Backend `Code.gs` (auth, rate limit, OCR, save) · Frontend PWA (`web/`) con modo MOCK | Wave 1 |
| 3 | Verificación: tests + screenshots modo MOCK mobile/desktop · `docs/SETUP.md` | Wave 2 |
