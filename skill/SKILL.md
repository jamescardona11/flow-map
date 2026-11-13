---
name: flow-map
description: Crea y mantiene la carpeta de un mapa de flujos de pantallas (map.json, capturas, aristas entre pantallas, historial) de una feature o de toda una app, web o móvil, a partir de capturas reales con Playwright, agent-device o argent. El mapa se ve, se ordena y se anota en la app Flow Map, no en este skill: el skill escribe la carpeta y la app la abre. Úsalo siempre que el usuario pida un "mapa de la feature", "mapa de flujos/pantallas", "screen map", "user flow con capturas", "ver todas las pantallas", "navegar la app visualmente", documentar un flujo con evidencia visual, "actualizar el mapa" tras cambiar una pantalla o saber qué pantallas cambiaron, comparar la app de hoy con un rediseño, o leer las anotaciones que el usuario dejó en un mapa; también si quiere recorrer una app con Playwright, agent-device o argent para dejarla mapeada. No es para tests e2e reproducibles, QA exploratorio que reporta bugs ni videos de la app.
---

# flow-map

Un mapa = una carpeta con `map.json` (pantallas, aristas, ramas sin explorar), `screens/*.png` y archivos de apoyo. **Este skill solo crea y mantiene esa carpeta.** Verla, ordenarla, comentarla y pedirle cambios a Claude lo hace la app **Flow Map** (el comando `flow-map`): el contrato entre las dos piezas es la carpeta, nada más (ADR 0001 de la app). Tú capturas con la herramienta de navegador o dispositivo que corresponda; el CLI `scripts/flowmap.py` registra, actualiza y valida, así el mapa nunca se edita a mano. En los ejemplos, `flowmap.py` es `python3 ~/.claude/skills/flow-map/scripts/flowmap.py`.

Esquema completo y todos los comandos: `references/schema.md`. Cómo capturar con cada herramienta: `references/capture-backends.md`.

## Antes de tocar la app

1. **Elige herramienta** según la plataforma: web → Playwright; móvil → agent-device primero, argent como respaldo. Detalles en `references/capture-backends.md`.
2. **Define la carpeta**: `flow-map/<feature>/` en la raíz del proyecto (o la que pida el usuario). `flowmap.py init <carpeta> --title "..." --platform web|ios|android`.
3. **Acuerda el alcance** con el usuario: qué flujos, con qué cuenta/datos, y qué está prohibido tocar. Explorar sin esto es lo que rompe datos reales.
4. **Lista de acciones prohibidas por defecto**: borrar, pagar, suscribirse, enviar mensajes o correos, cerrar sesión, resetear datos. Solo se hacen si el usuario las autoriza en esta sesión. Un paywall o un permiso del sistema se registra como límite del flujo; no prueba que la función protegida funcione.
5. **Usa cuentas y datos de prueba.** El mapa guarda capturas y el árbol de accesibilidad completos, con todo el texto visible. Si la app muestra datos reales de personas (en salud, pacientes), no los captures ni compartas la carpeta sin revisarla.

## Qué cuenta como pantalla

Una pantalla es un estado estable que el usuario distingue de otro: otro título, otro conjunto de acciones o otro resultado. Un modal o diálogo sobre una pantalla es una pantalla propia (con arista "abrir" desde ella y otra de vuelta). Misma pantalla con otros datos, otra fila de una lista o otro scroll no se duplica: en web captura página completa (`--full-page`) y usa `link`. Esta regla es la que mantiene el mapa legible y estable entre recapturas.

## Capturar (bucle)

Por cada pantalla estable: capturar imagen + árbol de accesibilidad, y registrarla.

```
flowmap.py add <carpeta> --id <screenId> --title "..." --flow "<Flujo>" --image <png> --tree <árbol.txt> \
  --from <screenIdPadre> --action 'tap «Continuar»'
```

- **`--id` semántico y estable** (`a1-elegir-institucion`, no `001`): es la identidad de la pantalla para siempre; recapturar usa el mismo id. Sin esto no hay forma de saber qué cambió.
- **`--flow`** agrupa pantallas en filas del mapa; un flujo por objetivo del usuario ("Entrar", "Agregar líder", "Errores").
- **`--action`** dice qué se hizo en la pantalla padre: `tap «Continuar»`, `escribir email inválido`, `submit`. Es la etiqueta de la flecha en la app, así que debe leerse sola.
- **Siempre pasa `--tree`** si la herramienta lo ofrece. Sin árbol, la detección de cambios cae a comparar píxeles y cualquier dato dinámico la dispara.
- **Esperar a que la pantalla se estabilice** antes de capturar (loaders, animaciones); si no, quedan capturas de transición.

### Bifurcaciones y vueltas

- Si de una pantalla sales por varias acciones, repite `add --from` (una por rama). La app muestra un botón por rama.
- Si una acción lleva a una pantalla que ya existe (volver, cancelar, ciclos): `flowmap.py link <carpeta> --from A --to B --action "..."`. No dupliques la pantalla.
- Si sabes dónde se tocó, añade `--at x,y,w,h` (0-1 sobre la pantalla de origen) a `add`/`link`: la app dibuja una zona clicable y la pantalla se recorre como un prototipo. Si los árboles traen marcos (`Button "Skip" (x, y, w, h)`), `flowmap.py hotspots <carpeta>` las deriva solo, cuando la acción nombra al elemento y la coincidencia es única.
- Cuando el árbol muestre algo tocable que no vas a explorar ahora: `flowmap.py frontier <carpeta> --from A --action "tap «Filtro»"`. Aparece en el mapa como rama punteada "sin explorar" y desaparece solo cuando después la registras con `add`/`link` con la misma acción. Así el mapa dice honestamente qué falta para cubrir la app.
- `flowmap.py flow <carpeta> --id F --hide` deja un flujo oculto al abrir el mapa, útil para material histórico.

### Exploración guiada

No hagas un crawl ciego de toda la app. Recorre un flujo a la vez, con un presupuesto de pasos acordado, y registra lo demás como `frontier`. Deduplica antes de añadir: si la pantalla ya existe con otros datos (otra fila de una lista), es la misma pantalla, usa `link`.

### Ejemplo

```
flowmap.py init flow-map/login --title "Login" --platform web
flowmap.py add flow-map/login --id a1-login --title "Login" --flow Entrar --image /tmp/a1.png --tree /tmp/a1.txt
flowmap.py add flow-map/login --id a2-error --title "Credenciales inválidas" --flow Entrar --image /tmp/a2.png --tree /tmp/a2.txt \
  --from a1-login --action 'enviar contraseña incorrecta'
flowmap.py link flow-map/login --from a2-error --to a1-login --action 'tap «Reintentar»'
flowmap.py frontier flow-map/login --from a1-login --action 'tap «Olvidé mi contraseña»'
flowmap.py check flow-map/login
```

## Validar y abrir en la app

```
flowmap.py check <carpeta>    # aristas rotas, imágenes faltantes (código 1 si hay problemas)
flowmap.py thumbs <carpeta>   # miniaturas que falten (add y update ya las crean; usa sips, macOS)
```

Este skill ya no genera ningún HTML ni sirve el mapa: `build`, `serve`, `portal` y `bundle` se retiraron y responden con un aviso que apunta a la app. Al terminar, **dile al usuario que abra la carpeta en la app Flow Map**:

```
flow-map open <carpeta>   # abre el mapa en el navegador por defecto (arranca la app si no corre)
flow-map                  # solo abre la app, con los recientes
```

(`flow-map` lo instala `./install` de la app; si no está en el PATH, es `node <repo de la app>/src/cli.ts open|app <carpeta>`). En la app el usuario recorre el lienzo con pan y zoom, ve el detalle de cada pantalla con sus salidas y entradas, ordena y agrupa pantallas, compara antes/después, ve el historial y comenta; la app recarga sola cuando este skill cambia `map.json`. No abras ventanas ni navegadores tú: dale el comando.

Lo que escribe la app en la carpeta y este skill no toca ni borra: `layout.json` (posiciones), `groups.json` (grupos), `DESIGN.md` (contrato de diseño para pantallas nuevas), `temp/` (comentarios y recortes), `exports/` (videos de rutas). El skill conserva las claves de `map.json` que no conoce.

## Leer las anotaciones del usuario

El usuario comenta pantallas (o zonas) en la app; los comentarios quedan en `<mapa>/temp/annotations.json` con un recorte PNG de cada uno. Para leerlos:

```
flowmap.py annotations <carpeta>   # el texto para Claude; sobre una carpeta de mapas junta los que tengan anotaciones
```

El texto abre con la instrucción de tratar cada comentario como la petición (y de no editar código si las capturas son de otra app) y trae la pantalla, su flujo, el recorrido desde la entrada, las rutas absolutas del recorte y de la captura completa, y el comentario; si la pantalla se recapturó después de anotarla, lo avisa. Cuando el usuario te pase anotaciones: abre cada recorte con Read, ubica la pantalla en `map.json` por su id y trabaja sobre esa zona, no sobre toda la captura. `temp/` es un borrador: bórralo al terminar.

## Actualizar tras un cambio

1. Recaptura solo las pantallas afectadas. El mapa no guarda qué archivo de código origina cada pantalla, así que decidir cuáles son (a partir de un diff, por ejemplo) es juicio tuyo: usa los títulos y flujos de `map.json`, y ante la duda recaptura el flujo entero.
2. `flowmap.py update <carpeta> --id <screenId> --image <png> --tree <árbol.txt>`. Responde `changed` y similitud; el JSON guarda qué líneas del árbol se añadieron/quitaron en `lastChange`. Si cambió, además guarda la captura reemplazada en `history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>` (hora UTC en que se tomó esa captura): una por cada recaptura con cambio, para ver cómo evolucionó la pantalla; la app lee esa carpeta.
3. `flowmap.py status <carpeta>` lista las pantallas cambiadas y las ramas pendientes.
4. Revisa con el usuario (en la app, la comparación muestra el antes y el después lado a lado) y confirma con `flowmap.py ack <carpeta> --id <screenId>`, que borra el «antes» (`history/<id>.<ext>`) pero nunca `history/<id>/`.

Si una pantalla cambió tanto que sus aristas ya no valen, recaptura también las vecinas: el CLI solo detecta cambios de la pantalla recapturada, no de las rutas hacia ella.

## Comparar la app actual con un rediseño

1. Por cada pantalla: `add ... --image <rediseño> --before <app de hoy>`; para una pantalla ya añadida, `flowmap.py baseline <carpeta> --id <id> --image <app de hoy>`. El «antes» queda en `baselines/` y la pantalla sigue `ok`, sin marcas de «changed». La app dibuja ambas lado a lado en el mapa (botón «Before | After») y en el detalle.
2. Las aristas salen de la navegación real del diseño (qué enlaza a qué), no se inventan. Pantallas sin captura de hoy no tienen «antes»: cuéntalas al entregar, es lo que falta por capturar.
3. Dile al usuario que abra la carpeta en la app para anotar por pantalla qué mantiene y qué quiere reevaluar, y luego lee sus comentarios con `flowmap.py annotations`.

## Pantallas HTML (mocks)

Para un diseño (una pantalla que aún no existe en la app, o un tablero), Claude escribe el HTML y el skill lo registra en la estructura:

```
flowmap.py add <carpeta> --id ... --image <png> --html <mock.html>     # al añadir la pantalla
flowmap.py html <carpeta> --id <id> --file <mock.html>                  # a una pantalla que ya existe (reemplaza el anterior)
```

El skill copia el archivo a `screens-src/<id>.html` y pone `"html"` en la pantalla. La app lo muestra vivo en el detalle (botón «Capture | HTML»), junto a la captura PNG, que sigue siendo la imagen del mapa (render del HTML con Playwright). El HTML debe ser **autocontenido**: CSS y JS en línea, imágenes y fuentes como `data:`, sin `<script src>`, `<link href>`, `@import`, `<iframe>` ni recursos de red; la app lo sirve en un `sandbox` sin red y el skill rechaza (código 1, sin escribir nada) lo que cargue algo externo, no sea `.html` o pase de 5 MB. `check` avisa si el archivo falta o la ruta no es relativa y dentro de la carpeta.

## Ligar esta sesión a la app (pedirte cambios desde el mapa)

Si el usuario quiere pedirle cosas a Claude desde la app (la caja del dock, «New screen», «Re-capture»), la app puede mandar esos mensajes a **esta** sesión en vez de lanzar un Claude aparte. Solo se puede ligar desde dentro de la sesión, porque el socket y el token están en sus variables (`CLAUDE_CODE_MESSAGING_SOCKET` y `CLAUDE_CODE_MESSAGING_TOKEN`), que ve tu herramienta Bash.

1. **Pregunta antes de ligar.** Ligar deja que la app inyecte mensajes en esta sesión: no lo hagas por tu cuenta aunque acabes de crear el mapa. Pregunta una vez («¿Ligo este mapa a esta sesión para que me pidas cambios desde la app?») y espera el sí.
2. Con el sí, ejecuta con la ruta **absoluta** de la carpeta: `flow-map link <carpeta>` (o `node <repo de la app>/src/cli.ts link <carpeta>` si `flow-map` no está en el PATH). Escribe el vínculo en el directorio de datos de la app (permisos 600), nunca dentro del mapa. Si responde que faltan las variables, esta sesión no admite mensajes entre sesiones: dilo y sugiere el camino sin sesión (en la app, «Run with a new Claude»).
3. La sesión solo atenderá los mensajes sin pedir permiso en la terminal si el usuario tiene en sus ajustes `"crossSessionInbound": "accept"` y reglas `allow` para leer y editar esa carpeta y ejecutar los comandos del skill. **No edites sus ajustes tú**: enséñale el bloque (con la ruta del mapa) y que lo mezcle él, o que lo copie del botón «?» del dock de la app:

```json
{
  "crossSessionInbound": "accept",
  "permissions": { "allow": [
    "Read(//<carpeta>/**)",
    "Edit(//<carpeta>/**)",
    "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)",
    "Bash(npx playwright screenshot *)"
  ] }
}
```

4. Dile que en el dock el chip pasa a «Session linked» (se actualiza en unos 10 s) y que las peticiones de la app llegan aquí como mensajes; al recibirlas, ejecuta el skill como siempre (`add`, `update`, `html`, `check`) y responde con lo que cambió. Un vínculo nuevo reemplaza al anterior de ese mapa.

## Qué no hace este skill

- No muestra ni sirve el mapa: eso es la app Flow Map.
- No decide por ti qué acciones son seguras: eso es el paso 4 de "Antes de tocar la app".
- No garantiza cobertura total de una app: lo no explorado queda como `frontier` o simplemente ausente. Dilo al entregar.
