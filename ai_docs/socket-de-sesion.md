# Enviar un mensaje a una sesión viva de Claude Code

Resultado de un spike (2026-11-05, Claude Code 2.1.318). Se comprobó contra la propia sesión desde donde se escribió.

## Cómo se alcanza una sesión

- Cada sesión abre un socket Unix (`srw-------`, solo el usuario) y lo anuncia en las variables `CLAUDE_CODE_MESSAGING_SOCKET` (ruta) y `CLAUDE_CODE_MESSAGING_TOKEN` (token). Ambas existen en el entorno de las herramientas Bash de esa sesión, así que un comando que corra desde ella puede leerlas.
- El token es una credencial: la app nunca lo muestra ni lo registra en logs ([ADR 0002](adr/0002-la-app-no-toca-los-ajustes-de-claude.md)).

## Formato del mensaje (confirmado)

Se toma del texto de ayuda que el propio binario imprime, y se verificó recibiendo el mensaje. Dos líneas JSON terminadas en salto de línea:

```
{"type":"auth","token":"<token>"}
{"type":"user","message":{"role":"user","content":"<texto>"}}
```

- No hay respuesta: ni a la línea de autenticación ni al mensaje. Que llegó solo se sabe porque la sesión lo muestra.
- La sesión receptora lo trata como el mensaje de otra sesión, no como del usuario; no puede aprobar permisos ni cambiar ajustes por él. Llega entre dos acciones de la sesión.
- Probados sin efecto: `{"type":"message","text":...}` y texto plano.
- La sesión cerrada se reconoce porque el socket no existe o rechaza la conexión.
- Lo que el emisor **no** puede distinguir: mensaje retenido (`crossSessionInbound: hold`) o rechazado (`refuse`). Por eso la app dice «enviada» o «la sesión no está», y no promete más.
