# Flow Map

Un mapa de todas las pantallas de una app, hecho con capturas reales, que puedes recorrer, ordenar y comentar. Desde el mismo mapa le pides cambios a Claude Code.

![Un mapa de una app móvil completa: cada bloque es un flujo y las líneas son las acciones que llevan de una pantalla a otra](ai_docs/img/ejemplo-mapa.png)

![El mismo mapa con una pantalla seleccionada: a la derecha, su captura, su descripción y las pantallas a las que lleva](ai_docs/img/ejemplo-detalle.png)

*La segunda captura es de una versión anterior: la barra y el panel derecho ya no se ven así.*

## Qué hace

- Abre cualquier carpeta de mapa y se recarga sola cuando la carpeta cambia.
- Guarda cómo ordenas las pantallas en el lienzo y los grupos que armas.
- Deja comentar una pantalla o una zona de ella, comparar una captura con la anterior y ver su historial.
- Exporta como video el recorrido entre dos pantallas.
- Manda peticiones a Claude Code: cambiar el mapa, maquetar una pantalla nueva o volver a capturar una que cambió.

## Cómo funciona

Son dos piezas que solo comparten una carpeta en disco.

El skill `/flow-map` (en `skill/`) lo usa Claude Code para crear y actualizar esa carpeta: `map.json`, las capturas y las conexiones entre pantallas. Claude navega la app con Playwright o `agent-device` y registra cada pantalla.

La app (en `src/`) abre la carpeta en el navegador. No captura nada por su cuenta: cuando pides algo desde el mapa, se lo pasa a tu sesión de Claude Code o lanza un `claude` aparte, y tú apruebas desde la interfaz los permisos que necesite.

## Instalación

Necesita macOS, Node 24 y Python 3.

```
git clone https://github.com/jamescardona11/flow-map.git flow-map && cd flow-map && npm install
./install          # pregunta dónde poner el skill y el comando
./install --yes    # sin preguntas: skill en ~/.claude/skills, comando en ~/.local/bin
```

Al terminar, el instalador lista las herramientas que no encuentra y cómo conseguirlas. `./install --tools` instala las dos que vienen de npm: `playwright-cli` para capturar web y `agent-device` para capturar móvil. `ffmpeg` (para el video) y `claude` son opcionales.

Otras opciones:

```
./install --symlink --skill-dir ~/.claude/skills --bin-dir ~/.local/bin     # enlaza el skill en vez de copiarlo
./install --app                                                             # crea Flow Map.app en ~/Applications
./install --uninstall --skill-dir ~/.claude/skills --bin-dir ~/.local/bin
```

El comando guarda la ruta de `node` y la de este repo. Si mueves el repo o cambias de Node, ejecuta `./install` otra vez.

Si quien instala es un agente, [`INSTALL.md`](INSTALL.md) tiene los pasos completos.

## Uso

Pídele a Claude Code un mapa («hazme el mapa de flujos del login») y el skill crea la carpeta. Luego:

```
flow-map open <carpeta>    # abre el mapa en el navegador
flow-map app <carpeta>     # lo abre en una ventana propia (necesita Chrome, Edge, Brave o similar)
flow-map                   # abre la app con los mapas recientes
flow-map link <carpeta>    # liga el mapa a la sesión de Claude Code desde la que lo ejecutas
```

Con el mapa ligado, lo que escribas en el dock de la app llega a esa sesión. Sin sesión, el botón «Run with a new Claude» hace el trabajo con un `claude` aparte.

## Limitaciones

- Solo macOS. El selector de carpetas, las miniaturas y la ventana propia dependen de él, y no se ha probado en Linux ni Windows.
- Cuando otro proceso cambia el mapa y la página se recarga, pierdes la selección y el modo de comparación. El texto a medio escribir se conserva.
- El video de una ruta admite 30 pantallas como máximo y no lleva subtítulos.

## Desarrollo

Node 24 ejecuta TypeScript directamente, así que no hay paso de compilación.

```
npm test             # tests de la app
npm run typecheck
npm start            # la app en el puerto 9999; PORT=<n> usa otro
python3 -m unittest discover -s skill/tests    # tests del skill
```

El visor no tiene tests automáticos. `tools/viewer-check.ts` lo prueba en un navegador real contra un `claude` simulado: `PLAYWRIGHT_CORE=<ruta a playwright-core> node tools/viewer-check.ts`.

## Más documentación

- [`ai_docs/referencia.md`](ai_docs/referencia.md): rutas HTTP, archivos que escribe la app, límites y errores.
- [`skill/references/schema.md`](skill/references/schema.md): el formato de la carpeta de un mapa y los comandos del skill.
- [`ai_docs/GLOSSARY.md`](ai_docs/GLOSSARY.md): el vocabulario del proyecto.
