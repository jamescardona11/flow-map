# Flow Map

Rules for working on this repo's code:

- If you are asked to install or use Flow Map (not to change its code), follow [`INSTALL.md`](INSTALL.md).
- Read `ai_docs/GLOSSARY.md` before naming things and `ai_docs/adr/` before changing a basic decision.
- If `ai_docs/plan/` exists (it is not versioned), the plan lives there. A story is built with its acceptance criteria as a checklist and its "Out of scope" section as the limit of the diff.
- The app and the `/flow-map` skill are separate pieces that share only the map folder ([ADR 0001](ai_docs/adr/0001-app-and-skill-are-separate.md)). Do not import code from one into the other.
- The app never changes the user's Claude Code settings ([ADR 0002](ai_docs/adr/0002-the-app-never-touches-claude-settings.md)).
- The linked session's token is a credential: it is not shown, not logged, not committed.
- Everything is written in English: documentation, the app's interface, code and comments (like the skill).
- Check what is visible in a real browser (Playwright) before saying it works, and say what you tested.
