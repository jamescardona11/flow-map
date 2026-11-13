# The app never changes the user's Claude Code settings

For a request sent from the app to be handled without permission prompts in the terminal, the linked session needs specific settings (accept messages from other sessions, and permission rules for whatever Claude is going to do). We decided that the app only shows those instructions and the person applies them. A message from another session cannot change configuration, and an app that edits the user's security settings would widen what Claude can do without anyone noticing.

## Considered Options

- **The app edits `settings.json` for the user:** rejected because it would apply to all their sessions without them seeing it, and because the session token is a credential: the app must not have more power than it needs.
- **No instructions, and Claude asks for permission in the terminal every time:** rejected because it breaks the promise of asking for changes without leaving the app.

## Consequences

- Any request may end up waiting for an approval in the terminal, and the app has to explain that.
- The session token is not shown and does not go to logs. The link lives in the app's data directory, `<dataDir>/sessions/<key>.json` (the key is the first 32 hexadecimal characters of the sha256 of the folder's real path), with mode 600, and not inside the map folder, so that a map folder (which may come from git) never carries a token and so that the worker's Read/Edit rules on the folder do not reach it. A `--disallowedTools` rule did not work, because it does not reach Bash subprocesses. This does **not** stop a worker steered by hostile text in a map from copying it with the commands the app lets it run (`flowmap.py ... --image/--tree <any path>` and `npx playwright screenshot file://...` accept paths outside the folder). That residual risk is accepted and bounded by the one-line text rule in the prompts, by the approval prompt for anything beyond the allowed rules, and by the worker running only at the designer's request. An old `session.json` in the folder that is a link (an object with `version` 1, `socket` and `token`) is deleted when the map is opened and when `link` runs; any other `session.json` is left as it is.
