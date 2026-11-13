# La app y el skill son piezas separadas que solo comparten la carpeta del mapa

El skill `/flow-map` (su fuente es `skill/` en este repo) crea y actualiza mapas desde Claude Code, y la app Flow Map los abre y los edita. Decidimos que ninguna importa código de la otra y que su único contrato es el formato de la carpeta del mapa (`map.json`, `screens/`, `layout.json`, `temp/`), versionado con el campo `version` de `map.json`. Así el skill sigue siendo útil sin la app, la app abre mapas hechos por cualquier versión del skill que entienda, y un cambio en una pieza no obliga a publicar la otra.

## Dónde vive el skill

`skill/` en este repo es la fuente del skill. `~/.claude/skills/flow-map`, que instala `./install` (copiado o enlazado), es un despliegue de ella. La app ejecuta `init` desde su propia copia en `skill/`, mientras que los prompts que le da a Claude usan la ruta del skill instalado.

## Considered Options

- **Un solo paquete con la app dentro del skill:** descartado porque la app necesita un servidor y una ventana persistentes y un ciclo de versiones propio, y el skill debe seguir siendo un directorio de instrucciones y scripts.
- **La app llama a los scripts del skill:** descartado porque ata la app a Python y a la ruta de instalación del skill.

## Consequences

- Hay que mantener compatible el esquema de la carpeta del mapa; un cambio incompatible sube `version` y la app avisa cuando no entiende una carpeta.
- Las dos piezas leen y escriben los mismos archivos, así que la app recarga cuando cambian y nunca asume que es la única que escribe.

## Un segundo contrato, sin versión

Además del formato de la carpeta del mapa, la app depende de tres cosas del skill que no llevan versión:

- **Su CLI `add`, `update`, `html`, `link` y `check`.** Las peticiones de «New screen» (`src/new-screen.ts`), «Capture» (`src/capture-new.ts`) y «Re-capture» (`src/recapture.ts`) piden a Claude que ejecute `flowmap.py add` (con `--id`, `--title`, `--flow`, `--image`, `--from`, `--action`, `--description`; también acepta `--html`), `update` (con `--id` e `--image`), `html` (con `--id` y `--file`: copia el HTML a `screens-src/<id>.html`, fija la clave `html` y rechaza archivos que no son autocontenidos), `link` (solo la transición, para una pantalla que el mapa ya tiene) y `check`. La ruta de instalación del skill está escrita en `src/skill-command.ts` (`FLOW_MAP_COMMAND`), y de ahí salen también las reglas de permisos que la app sugiere. La app ya no edita a mano la clave `html` de `map.json`: la fija el skill.
- **El texto de la exportación de comentarios,** copiado del skill en `src/annotations.ts` (el formato de `temp/annotations.json` y el texto de `export`).
- **Su `init`, que la app ejecuta desde su propia copia en `skill/`** (`src/scratch-map.ts`) para crear el mapa de trabajo; en cambio, los prompts que la app le da a Claude usan la ruta del skill instalado.

Este contrato no lo cubre el campo `version` de `map.json`: si el skill cambia un subcomando, un flag, su ruta o el texto de la exportación, la app falla sin aviso. Un cambio en el CLI del skill se hace junto con `src/new-screen.ts`, `src/recapture.ts`, `src/skill-command.ts` y `src/annotations.ts`. La decisión de arriba no cambia: sigue sin haber código compartido.
