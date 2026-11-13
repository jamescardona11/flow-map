# La app nunca cambia los ajustes de Claude Code del usuario

Para que una petición enviada desde la app se atienda sin pedir permisos en la terminal, la sesión ligada necesita ajustes concretos (aceptar mensajes de otras sesiones y reglas de permiso para lo que Claude vaya a hacer). Decidimos que la app solo muestra esas instrucciones y que la persona las aplica. Un mensaje de otra sesión no puede cambiar configuración, y una app que edita ajustes de seguridad del usuario ampliaría sin que se note lo que Claude puede hacer.

## Considered Options

- **La app edita `settings.json` por el usuario:** descartada porque aplicaría a todas sus sesiones sin que lo vea y porque el token de la sesión es una credencial: la app no debe tener más poder del necesario.
- **Sin instrucciones y que Claude pida permiso en la terminal cada vez:** descartada porque rompe la promesa de pedir cambios sin salir de la app.

## Consequences

- Toda petición puede quedar esperando una aprobación en la terminal, y la app tiene que explicarlo.
- El token de la sesión no se muestra y no va a logs. El enlace vive en el directorio de datos de la app, `<dataDir>/sessions/<clave>.json` (la clave son los 32 primeros caracteres hexadecimales del sha256 de la ruta real de la carpeta), con modo 600, y no dentro de la carpeta del mapa, para que una carpeta de mapa (que puede llegar desde git) nunca lleve un token y para que las reglas de Read/Edit del worker sobre la carpeta no lo alcancen. Una regla `--disallowedTools` no servía, porque no alcanza a los subprocesos de Bash. Esto **no** impide que un worker dirigido por texto hostil de un mapa lo copie con los comandos que la app le permite ejecutar (`flowmap.py ... --image/--tree <cualquier ruta>` y `npx playwright screenshot file://...` aceptan rutas fuera de la carpeta). Ese riesgo residual se acepta y lo acotan la regla de texto de una línea en los prompts, el aviso de aprobación para todo lo que pase de las reglas permitidas y que el worker solo corre a petición del diseñador. Un `session.json` antiguo en la carpeta que sea un vínculo (objeto con `version` 1, `socket` y `token`) se borra al abrir el mapa y al ejecutar `link`; cualquier otro `session.json` se deja como está.
