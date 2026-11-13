# Install and use Flow Map (instructions for an agent)

This file is for an agent (Claude Code or another) whose user asked it to install Flow Map and get it working. To work *on* the repo's code, read [`AGENTS.md`](AGENTS.md). The detail of each part is in [`ai_docs/reference.md`](ai_docs/reference.md).

Flow Map is two pieces that share only a folder on disk (the map folder):

- the **`/flow-map` skill**, which you use to create and update a map folder;
- the **Flow Map app**, where the user views, arranges and comments on that map, and from which they ask you for changes.

## 1. Requirements

You check the first two before installing. `./install` checks the rest when it finishes: it names what is missing and how to get it (step 2).

| Requirement | Check | What for |
|---|---|---|
| macOS | `uname` prints `Darwin` | The folder picker, the thumbnails (`sips`) and the app window only exist on macOS. Not tested on Linux or Windows. |
| Node 24 or later | `node --version` | The app runs TypeScript without compiling. |
| Python 3 | `python3 --version` | The skill's CLI (`flowmap.py`); it uses only the standard library. |
| `playwright-cli` | `playwright-cli --version` | Capture web apps with the skill. npm package `@playwright/cli`. |
| `agent-device` | `agent-device --version` | Capture iOS and Android apps. npm package `agent-device`. Only needed to map mobile apps. |
| Playwright's Chromium | no quick check: download it once with `npx playwright install chromium` | The app's "New screen", "Re-capture" and "Capture it now" for web, which run `npx playwright screenshot`. |
| `ffmpeg` (optional) | `ffmpeg -version` | Export a route as video. |
| `claude` on the PATH (optional) | `claude --version` | "Run with a new Claude" from the app. |

## 2. Install

```
git clone https://github.com/jamescardona11/flow-map.git flow-map
cd flow-map
npm install
./install --yes
```

`./install --yes` asks nothing: it copies the skill to `~/.claude/skills/flow-map` and writes the `flow-map` command to `~/.local/bin`. It does not overwrite files that are not its own and does not edit the shell profile. Other options (`--symlink`, other folders, `--uninstall`, `Flow Map.app`) are in the README's "Install" section.

When it finishes, the installer lists under "Missing tools" the tools it cannot find on the PATH, with the command to get each one. It installs none of them on its own. If `playwright-cli` or `agent-device` is missing:

1. Ask the user whether they will map web apps, mobile apps or both, and whether they want you to install them (they are global npm packages).
2. If they say yes, run `./install --tools`: it runs `npm install -g` for whichever of those two is missing and nothing else. If they only want one, run the `npm install -g ...` command the installer printed for it.
3. For web, download the browser once: `playwright-cli install-browser` (for the skill) and `npx playwright install chromium` (for requests from the app).

The installer does not install `ffmpeg`, `claude` or Python: show the user the line it prints.

Three more things to know:

- If `~/.local/bin` is not on the PATH, the installer prints the `export PATH=...` line. Show it to the user so they add it to their profile; do not edit their profile yourself. Meanwhile use the full path `~/.local/bin/flow-map`.
- The command stores the absolute paths of `node` and of the repo. If the repo moves or the Node version changes, run `./install --yes` again.
- A newly installed skill shows up in Claude Code when a new session starts. In the current session you can still use it by reading `~/.claude/skills/flow-map/SKILL.md`.

## 3. Verify the installation

```
flow-map open --no-browser
```

It must print `Opened the app at http://127.0.0.1:<port>/` and exit with code 0. The app keeps running in the background (port 9999 by default; `PORT=<n>` uses another). If it says "The app did not start within 5 seconds", run `npm start` in the repo to see the error; the usual cause is that the port is already taken.

## 4. Create a map

Follow `~/.claude/skills/flow-map/SKILL.md`: it is the complete guide (scope, forbidden actions, what counts as a screen, how to recapture). The minimal path, where `flowmap.py` is `python3 ~/.claude/skills/flow-map/scripts/flowmap.py`:

```
flowmap.py init <folder> --title "..." --platform web|ios|android
flowmap.py add <folder> --id <id> --title "..." --flow "<Flow>" --image <png> --tree <tree.txt>
flowmap.py add <folder> --id <id2> ... --from <id> --action 'tap «Continue»'
flowmap.py check <folder>
```

Before capturing, agree with the user on which flows to walk through, with which account, and what must not be touched. Captures store all the visible text: use test data.

## 5. Open the map

```
flow-map open <folder>    # in the default browser
flow-map app <folder>     # in its own window (needs a Chromium-based browser)
```

Do not open browsers yourself when you finish a map: give the user the command. The app reloads by itself when the skill changes `map.json`.

## 6. Receive requests from the app (optional)

The app can send what the user types in the map to your Claude Code session.

1. **Ask first.** Linking lets the app inject messages into your session.
2. If they say yes, run `flow-map link <absolute path of the folder>` from inside the session.
3. For the messages to be handled without a permission prompt in the terminal, the user must add a block to their Claude Code settings. Show it to them (it is in `SKILL.md`, in the section about linking this session to the app, and behind the dock's "How to set this up" button). **Do not edit their settings yourself.**

The link stores the session token in `~/.flow-map/sessions/`. It is a credential: do not show it, copy it or commit it to git.

## 7. Read the user's comments

```
flowmap.py annotations <folder>
```

It returns each comment with its screen, its route and the paths of the crop and of the capture. Open each crop with Read and work on that area.

## Where things end up

| What | Where |
|---|---|
| Skill | `~/.claude/skills/flow-map` |
| Command | `~/.local/bin/flow-map` |
| App data (recents, session links, working map) | `~/.flow-map` (or `$FLOW_MAP_HOME`) |
| A map | the folder you choose, for example `flow-map/<feature>/` in the user's project |

Uninstall: `./install --uninstall --skill-dir ~/.claude/skills --bin-dir ~/.local/bin`. It does not delete `~/.flow-map` or any map.
