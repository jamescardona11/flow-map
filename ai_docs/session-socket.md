# Sending a message to a live Claude Code session

Result of a spike (2026-11-05, Claude Code 2.1.318). It was checked against the very session it was written from.

## How a session is reached

- Each session opens a Unix socket (`srw-------`, owner only) and announces it in the variables `CLAUDE_CODE_MESSAGING_SOCKET` (path) and `CLAUDE_CODE_MESSAGING_TOKEN` (token). Both exist in the environment of that session's Bash tools, so a command run from it can read them.
- The token is a credential: the app never shows it or writes it to logs ([ADR 0002](adr/0002-the-app-never-touches-claude-settings.md)).

## Message format (confirmed)

It comes from the help text the binary itself prints, and was verified by receiving the message. Two JSON lines, each ending in a newline:

```
{"type":"auth","token":"<token>"}
{"type":"user","message":{"role":"user","content":"<text>"}}
```

- There is no reply, neither to the auth line nor to the message. The only way to know it arrived is that the session shows it.
- The receiving session treats it as a message from another session, not from the user; it cannot approve permissions or change settings because of it. It arrives between two actions of the session.
- Tried without effect: `{"type":"message","text":...}` and plain text.
- A closed session is recognised because the socket does not exist or refuses the connection.
- What the sender **cannot** tell apart: a held message (`crossSessionInbound: hold`) from a refused one (`refuse`). That is why the app says "sent" or "the session is gone", and promises nothing more.
