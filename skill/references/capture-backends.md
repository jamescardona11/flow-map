# Capturar pantalla + árbol según la herramienta

`flowmap.py add/update` necesita dos archivos por pantalla: un PNG y, idealmente, el árbol de accesibilidad como texto. Cualquier herramienta sirve mientras entregue ambos como archivos locales. Orden de preferencia: **Playwright** (web) → **agent-device** (móvil) → **argent** (respaldo).

Verificado con la CLI/schemas de las herramientas el 2026-10-29; lo marcado "sin probar" no se ejecutó de punta a punta, comprueba en la primera captura que el archivo existe y no está vacío.

## Web: Playwright (`playwright-cli`)

```
playwright-cli goto <url-http>                       # file: está bloqueado; sirve el sitio por http
playwright-cli resize 1440 900                       # fija el viewport: mismas dimensiones en todas las capturas
playwright-cli screenshot --filename=<dir>/a1.png    # --full-page si la pantalla hace scroll
playwright-cli snapshot --filename=<dir>/a1.txt      # árbol de accesibilidad (refs incluidos)
playwright-cli click <ref>                           # refs salen del snapshot
```

Los refs (`e12`) cambian entre snapshots; el normalizador de `flowmap` los trata como números y no cuentan como cambio. Si hay sesión/login, hazlo antes de la primera captura y no lo registres como pantalla salvo que el login sea parte del flujo.

## Móvil: agent-device (MCP)

- `screenshot` con `path: <dir>/a1.png` guarda el PNG. Acepta `platform: "web"`, así que también cubre web si Playwright no está.
- `snapshot` devuelve el árbol como texto en la respuesta y no tiene parámetro de salida: guarda ese texto tú en `<dir>/a1.txt` (Write). Usa `interactiveOnly: true` para exploración, pero para el mapa usa el árbol completo: es la base del diff.
- Para moverte usa `press`/`click`/`fill`/`back` con `settle: true` (la respuesta ya espera a que la UI se estabilice).
- Si el árbol viene vacío o con advertencia de AX no disponible, captura igual y registra la pantalla sin `--tree`; la detección de cambios será por píxeles (sin probar con una app real en esta versión del skill).

## Móvil: argent (respaldo)

- `screenshot` baja por defecto a escala 0.25: pasa `scale: 1.0` o las capturas del mapa saldrán borrosas. Con `includeImageInContext: false` el archivo se escribe igualmente; lee su ruta en el resultado (sin probar dónde la deja en cada plataforma) y pásala a `--image`.
- `describe` entrega el árbol de accesibilidad como texto; guárdalo en un `.txt` y pásalo a `--tree`.
- Las herramientas de interacción devuelven la pantalla después de la acción, útil para decidir el siguiente `--action`.
- Teléfono físico: la captura solo cubre la app registrada con `launch-app`; las pantallas del sistema (permisos) no entran.

## Nombres de archivo

Guarda las capturas crudas en una carpeta temporal y deja que `flowmap.py` las copie a `screens/<id>.png`. No apuntes `--image` a `screens/` salvo para re-registrar la misma imagen con otro árbol (funciona, no copia).
