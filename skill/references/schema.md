# Esquema de `map.json` y comandos

Esta carpeta es el contrato entre el skill (que la escribe) y la app Flow Map (el comando `flow-map`, que la abre, la ordena y la comenta). El skill no genera HTML ni sirve el mapa.

```
<carpeta>/
├── map.json        fuente de verdad (el CLI lo escribe; no lo edites a mano)
├── screens/<id>.png  (el sufijo es el del archivo capturado: puede ser .jpg)
├── thumbs/<id>.jpg miniatura de 560 px de alto para el mapa (solo si la captura es más alta y hay `sips`, macOS)
├── history/<id>.png  el «antes» de una pantalla cambiada, hasta que se hace `ack`
├── history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>  una por cada captura reemplazada por `update` con cambio; el nombre es la hora UTC en que se tomó esa captura (si ya existe, `-2`, `-3`…); el CLI nunca la borra
├── baselines/<id>.png  el «antes» fijado a propósito (la app de hoy frente a un rediseño); no lo borra `ack`
├── trees/<id>.txt  árbol de accesibilidad tal como llegó (evidencia + base del diff)
├── evidence/<id>.txt  opcional: salida cruda de la captura, sin tocar; se enlaza con meta.evidence (solo al importar)
├── layout.json     lo escribe la app: posiciones que el usuario arrastró ({positions: {id: {x, y}}}); opcional; el skill no lo toca
├── groups.json     lo escribe la app: grupos de pantallas que se mueven juntas; opcional; el skill no lo toca
├── DESIGN.md       lo escribe el usuario desde la app: contrato de diseño para las pantallas nuevas; opcional
├── screens-src/<id>.html  mock HTML autocontenido (`screens[].html`); lo copia `add --html` / `html`. También sus PNG de trabajo cuando Claude renderiza
├── exports/        lo escribe la app: videos de rutas
└── temp/           lo escribe la app: annotations.json + recortes <id>-NN.png (borrador; bórralo al terminar)
```

## map.json

```json
{
  "version": 1,
  "title": "Findings leaders",
  "platform": "web",                       // web | ios | android
  "meta": { "subtitle": "iPhone 16 Pro · 1.24.4", "blocks": ["Pro requerido"], "status": "parcial" },  // opcional, libre; la app usa subtitle y blocks
  "entry": "a1-elegir-institucion",       // primera pantalla añadida; la app abre aquí
  "flows":   [{ "id": "entrar", "title": "Entrar", "color": "#5aa9e6", "hidden": true }],  // hidden: la app lo oculta al abrir
  "screens": [{
    "id": "a1-elegir-institucion",         // estable; minúsculas, dígitos y guiones
    "title": "Elegir institución",
    "flow": "entrar",
    "description": "",
    "image": "screens/a1-elegir-institucion.png",
    "thumb": "thumbs/a1-elegir-institucion.jpg",   // opcional; la app la usa en el mapa y en las tarjetas de navegación
    "previous": "history/a1-elegir-institucion.png", // opcional; existe mientras el cambio no se haya revisado
    "baseline": "baselines/a1-elegir-institucion.png", // opcional; «antes» fijo para comparar; la app lo prefiere a `previous`
    "baselineThumb": "thumbs/a1-elegir-institucion-before.jpg", // opcional; miniatura del baseline
    "width": 1440, "height": 900,          // PNG o JPEG (por contenido); null si no se pudo leer
    "fingerprintKind": "tree",             // tree | image (si no había árbol)
    "fingerprint": "…",
    "capturedAt": "2026-10-29T12:23:17+00:00",
    "status": "ok",                        // ok | changed
    "meta": { "evidence": "evidence/a1.txt" },  // opcional, libre; la app enlaza meta.evidence como «Texto de pantalla»
    "lastChange": { "at": "…", "similarity": 0.81, "added": ["…"], "removed": ["…"] },  // solo si changed
    "html": "screens-src/a1-elegir-institucion.html"  // opcional: mock HTML autocontenido que la app muestra vivo; lo escribe `add --html` / `html`
  }],
  "edges":    [{ "from": "a1-…", "to": "a2-…", "action": "tap «Continuar»", "at": { "x": 0.1, "y": 0.9, "w": 0.2, "h": 0.05 } }],  // at: zona tocada (0-1), opcional
  "frontier": [{ "from": "a2-…", "action": "tap «Filtro»" }]
}
```

- `edges` pueden cruzar flujos y apuntar hacia atrás (ciclos, "volver"). La app dibuja las de vuelta punteadas por debajo.
- `meta` (del mapa y de cada pantalla) solo se escribe desde la API de Python (`init(..., meta=)`, `add(..., meta=, captured_at=)`), pensado para importar mapas ya existentes sin perder sus datos; `update` no lo toca. `capturedAt` por defecto es la hora de la captura; `add --captured-at` o `captured_at=` fija una fecha real al importar.
- `at` hace que la app dibuje una zona clicable sobre la captura de origen (tecla H). La escribe `link/add --at x,y,w,h` o `hotspots`.
- `frontier` = acciones vistas y no exploradas. Se borran solas cuando la misma `(from, action)` entra como arista.

## Huella y detección de cambios

La huella sale del árbol de accesibilidad: cada línea se normaliza (minúsculas, los números y series de números, como coordenadas, pasan a `#`) y se hashea el conjunto ordenado. Por eso un contador o una hora no cuentan como cambio, pero un texto o un botón nuevo sí. `similarity` es Jaccard entre el conjunto de líneas viejo y el nuevo (1 = igual). Sin árbol se compara el hash del PNG, que se dispara con cualquier dato dinámico.

Limitación conocida: datos dinámicos que sean texto (nombres, fechas escritas) sí marcan `changed`. Mira `lastChange` antes de dar el cambio por real.

## Comandos (`scripts/flowmap.py`)

| Comando | Qué hace |
|---|---|
| `init <dir> --title T [--platform web\|ios\|android]` | crea la carpeta y `map.json` vacío |
| `add <dir> --id --title --flow --image [--tree] [--description] [--from --action [--at x,y,w,h]] [--captured-at ISO] [--before IMG]` | añade pantalla (y arista si hay `--from`); crea el flujo si es nuevo |
| `link <dir> --from --to --action [--at x,y,w,h]` | arista entre pantallas existentes; idempotente (un `--at` nuevo reemplaza al anterior) |
| `frontier <dir> --from --action` | rama vista pero sin explorar |
| `update <dir> --id --image [--tree]` | recaptura; imprime `{"id", "changed", "similarity"}` (`similarity` solo si cambió); si cambió, guarda el «antes» en `history/<id>.<ext>` y la captura reemplazada en `history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>` (la hora sale del `capturedAt` anterior, en UTC; sin él, de la fecha del archivo; la app Flow Map lee esta carpeta y muestra el historial) |
| `baseline <dir> --id --image` | fija (o reemplaza) el «antes» de una pantalla existente sin marcarla `changed`; `add --before` hace lo mismo al añadir |
| `ack <dir> --id` | da por revisado un cambio y borra su «antes» (`history/<id>.<ext>`); no toca `history/<id>/` |
| `status <dir>` | pantallas cambiadas y ramas pendientes |
| `check <dir>` | valida; sale con código 1 si hay problemas |
| `thumbs <dir>` | genera las miniaturas que falten (`add` y `update` ya las crean) |
| `flow <dir> --id F --hide\|--show` | oculta o muestra un flujo al abrir el mapa en la app |
| `hotspots <dir> [--overwrite]` | deriva `at` de cada arista buscando en el árbol de origen el elemento que nombra la acción; solo con árboles que traen marcos `Role "label" (x, y, w, h)` y si la coincidencia es única; agranda lo diminuto a un mínimo pulsable |
| `add ... --html FILE` / `html <dir> --id --file FILE` | copia un mock HTML autocontenido a `screens-src/<id>.html` y pone `screens[].html`; rechaza (código 1, sin escribir) lo que cargue recursos externos (`<script src>`, `<link href>`, `@import`, `url()`/`src` no `data:`, `iframe/object/embed`), lo que no sea `.html`/`.htm` o pase de 5 MB; `update` y `ack` no lo tocan |
| `annotations <dir>` | el texto de las anotaciones (`temp/annotations.json`, que escribe la app) para pasárselo a Claude; sobre una carpeta de mapas junta los que tengan anotaciones |
| `build`, `serve`, `portal`, `bundle` | **retirados**: imprimen un aviso (el visor vive en la app Flow Map: `flow-map open <dir>`), salen con código 1 y no escriben nada |

Errores: mensaje en stderr y código 1.

Abrir un mapa: `flow-map open <dir>` (o `flow-map app <dir>` para una ventana propia); el comando lo instala `./install` de la app. El skill nunca lo ejecuta por su cuenta.

## Pruebas

`python3 -m unittest discover -s tests` desde la carpeta del skill.

## Anotaciones (`temp/annotations.json`)

```json
{ "version": 1, "seq": { "s003": 1 },
  "annotations": [{ "id": "s003-01", "screen": "s003", "rect": { "x": 0.12, "y": 0.15, "w": 0.71, "h": 0.18 },
                    "comment": "…", "crop": "temp/s003-01.png", "fingerprint": "…", "at": "2026-10-29T21:00:00+00:00" }] }
```

`rect` va normalizado (0-1) sobre la captura. `seq` evita reutilizar el número de una anotación borrada. `fingerprint` es el de la pantalla al anotar: si cambia, `annotations` avisa de que se recapturó. **Las anotaciones, `layout.json` y `groups.json` los escribe solo la app** (`/__flowmap/annotations`, `/__flowmap/layout`, `/__flowmap/groups`, solo desde la propia página); el skill solo lee `temp/annotations.json` para exportarlo.
