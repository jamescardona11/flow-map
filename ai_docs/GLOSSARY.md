# Flow Map

Una aplicación para ver y ordenar mapas de pantallas y pedirle cambios a Claude Code. El vocabulario de abajo es el de la app y el del skill `/flow-map`.

## Language

**Mapa**:
El conjunto de pantallas de una app y las flechas que dicen cómo se pasa de una a otra, con las notas y la disposición que la persona le dio.
_Avoid_: Diagrama, flujo (un flujo es solo una fila del mapa)

**Carpeta del mapa**:
La carpeta que contiene todo un mapa y es lo único que comparten la app y el skill.
_Avoid_: Proyecto, archivo de configuración

**Pantalla**:
Un estado estable de la app que la persona distingue de otro, con su captura o su diseño.
_Avoid_: Vista, nodo (nodo es solo cómo se dibuja)

**Petición**:
Lo que la persona le pide a Claude desde la app: un cambio en el mapa o una pantalla nueva.
_Avoid_: Prompt, comando

**Sesión ligada**:
La sesión de Claude Code abierta que se eligió para atender las peticiones de un mapa. Cada mapa tiene a lo sumo una.
_Avoid_: Conexión, chat

**Claude propio**:
Un Claude Code que la app lanza por su cuenta para atender peticiones cuando no hay sesión ligada abierta.
_Avoid_: Bot, agente de fondo
