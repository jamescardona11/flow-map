# Flow Map

An app to view and arrange screen maps and to ask Claude Code for changes. The vocabulary below is the one used by the app and by the `/flow-map` skill.

## Language

**Map**:
The set of screens of an app and the arrows saying how to get from one to another, with the notes and layout the person gave it.
_Avoid_: Diagram, flow (a flow is only one row of the map)

**Map folder**:
The folder holding a whole map; it is the only thing the app and the skill share.
_Avoid_: Project, config file

**Screen**:
A stable state of the app that a person tells apart from another, with its capture or its design.
_Avoid_: View, node (a node is only how it is drawn)

**Request**:
What the person asks Claude for from the app: a change to the map or a new screen.
_Avoid_: Prompt, command

**Linked session**:
The open Claude Code session chosen to handle the requests of a map. Each map has at most one.
_Avoid_: Connection, chat

**Own Claude**:
A Claude Code the app launches by itself to handle requests when no linked session is open (called the worker in the code).
_Avoid_: Bot, background agent
