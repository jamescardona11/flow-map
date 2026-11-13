# Instalar y usar Flow Map (instrucciones para un agente)

Este archivo es para un agente (Claude Code u otro) al que su usuario le pide instalar Flow Map y dejarlo funcionando. Para trabajar *en* el código del repo, lee [`AGENTS.md`](AGENTS.md). La referencia completa de cada parte está en [`README.md`](README.md).

Flow Map son dos piezas que solo comparten una carpeta en disco (la carpeta del mapa):

- el **skill `/flow-map`**, con el que tú creas y actualizas la carpeta de un mapa;
- la **app Flow Map**, donde el usuario ve, ordena y comenta ese mapa, y desde donde te pide cambios.

## 1. Requisitos

Comprueba cada uno antes de instalar y dile al usuario lo que falte; no lo instales por tu cuenta.

| Requisito | Comprobación | Para qué |
|---|---|---|
| macOS | `uname` responde `Darwin` | El selector de carpetas, las miniaturas (`sips`) y la ventana propia solo existen en macOS. No se ha probado en Linux ni Windows. |
| Node 24 o superior | `node --version` | La app ejecuta TypeScript sin compilar. |
| Python 3 | `python3 --version` | El CLI del skill (`flowmap.py`); solo usa la biblioteca estándar. |
| Una herramienta de captura | Playwright para web; `agent-device` para móvil | Tomar las capturas. Ver `skill/references/capture-backends.md`. |
| `ffmpeg` (opcional) | `ffmpeg -version` | Exportar una ruta como video. |
| `claude` en el PATH (opcional) | `claude --version` | «Run with a new Claude» desde la app. |

## 2. Instalar

```
git clone <url del repo> flow-map
cd flow-map
npm install
./install --yes
```

`./install --yes` no pregunta nada: copia el skill a `~/.claude/skills/flow-map` y escribe el comando `flow-map` en `~/.local/bin`. No pisa archivos que no sean suyos y no edita el perfil del shell. Otras formas (`--symlink`, otras carpetas, `--uninstall`, `Flow Map.app`) están en la sección «Instalación» del README.

Tres cosas que debes saber:

- Si `~/.local/bin` no está en el PATH, el instalador imprime la línea `export PATH=...`. Enséñasela al usuario para que la añada a su perfil; no edites su perfil tú. Mientras tanto usa la ruta completa `~/.local/bin/flow-map`.
- El comando guarda las rutas absolutas de `node` y del repo. Si el repo se mueve o cambia la versión de Node, vuelve a ejecutar `./install --yes`.
- Un skill recién instalado aparece en Claude Code al iniciar una sesión nueva. En la sesión actual puedes usarlo igual leyendo `~/.claude/skills/flow-map/SKILL.md`.

## 3. Verificar la instalación

```
flow-map open --no-browser
```

Debe imprimir `Opened the app at http://127.0.0.1:<puerto>/` y terminar con código 0. La app queda corriendo en segundo plano (puerto 9999 por defecto; `PORT=<n>` usa otro). Si responde «The app did not start within 5 seconds», ejecuta `npm start` en el repo para ver el error; la causa habitual es que el puerto ya está ocupado.

## 4. Crear un mapa

Sigue `~/.claude/skills/flow-map/SKILL.md`: es la guía completa (alcance, acciones prohibidas, qué cuenta como pantalla, cómo recapturar). El recorrido mínimo, donde `flowmap.py` es `python3 ~/.claude/skills/flow-map/scripts/flowmap.py`:

```
flowmap.py init <carpeta> --title "..." --platform web|ios|android
flowmap.py add <carpeta> --id <id> --title "..." --flow "<Flujo>" --image <png> --tree <árbol.txt>
flowmap.py add <carpeta> --id <id2> ... --from <id> --action 'tap «Continuar»'
flowmap.py check <carpeta>
```

Antes de capturar acuerda con el usuario qué flujos recorrer, con qué cuenta y qué no se puede tocar. Las capturas guardan todo el texto visible: usa datos de prueba.

## 5. Abrir el mapa

```
flow-map open <carpeta>    # en el navegador por defecto
flow-map app <carpeta>     # en una ventana propia (necesita un navegador basado en Chromium)
```

No abras navegadores por tu cuenta al terminar un mapa: dale el comando al usuario. La app se recarga sola cuando el skill cambia `map.json`.

## 6. Recibir peticiones desde la app (opcional)

La app puede mandar a tu sesión de Claude Code lo que el usuario escribe en el mapa.

1. **Pregunta antes.** Ligar permite que la app inyecte mensajes en tu sesión.
2. Con el sí, ejecuta `flow-map link <ruta absoluta de la carpeta>` desde dentro de la sesión.
3. Para que los mensajes se atiendan sin pedir permiso en la terminal, el usuario debe añadir un bloque a sus ajustes de Claude Code. Enséñaselo (está en `SKILL.md`, sección «Ligar esta sesión a la app», y en el botón «How to set this up» del dock). **No edites sus ajustes tú.**

El vínculo guarda el token de la sesión en `~/.flow-map/sessions/`. Es una credencial: no lo muestres, no lo copies y no lo subas a git.

## 7. Leer los comentarios del usuario

```
flowmap.py annotations <carpeta>
```

Devuelve cada comentario con la pantalla, su recorrido y las rutas del recorte y de la captura. Abre cada recorte con Read y trabaja sobre esa zona.

## Dónde queda cada cosa

| Qué | Dónde |
|---|---|
| Skill | `~/.claude/skills/flow-map` |
| Comando | `~/.local/bin/flow-map` |
| Datos de la app (recientes, vínculos de sesión, mapa de trabajo) | `~/.flow-map` (o `$FLOW_MAP_HOME`) |
| Un mapa | la carpeta que elijas, por ejemplo `flow-map/<feature>/` en el proyecto del usuario |

Desinstalar: `./install --uninstall --skill-dir ~/.claude/skills --bin-dir ~/.local/bin`. No borra `~/.flow-map` ni ningún mapa.
