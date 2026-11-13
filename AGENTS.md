# Flow Map

Reglas para trabajar en el código de este repo:

- Si te piden instalar o usar Flow Map (no cambiar su código), sigue [`INSTALL.md`](INSTALL.md).
- Lee `ai_docs/GLOSSARY.md` antes de nombrar cosas y `ai_docs/adr/` antes de cambiar una decisión de fondo.
- Si existe `ai_docs/plan/` (no se versiona), el plan vive ahí. Una historia se construye con sus criterios de aceptación como checklist y su sección «Out of scope» como límite del diff.
- La app y el skill `/flow-map` son piezas separadas que solo comparten la carpeta del mapa ([ADR 0001](ai_docs/adr/0001-app-y-skill-separados.md)). No importes código de una en la otra.
- La app nunca cambia los ajustes de Claude Code del usuario ([ADR 0002](ai_docs/adr/0002-la-app-no-toca-los-ajustes-de-claude.md)).
- El token de la sesión ligada es una credencial: no se muestra, no se registra en logs, no se versiona.
- Documentos en español; interfaz de la app y código en inglés (como el skill).
- Verifica lo visible en un navegador real (Playwright) antes de decir que funciona, y di qué probaste.
