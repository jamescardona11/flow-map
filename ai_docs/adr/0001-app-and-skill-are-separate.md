# The app and the skill are separate pieces that share only the map folder

The `/flow-map` skill (its source is `skill/` in this repo) creates and updates maps from Claude Code, and the Flow Map app opens and edits them. We decided that neither imports code from the other and that their only contract is the format of the map folder (`map.json`, `screens/`, `layout.json`, `temp/`), versioned with the `version` field of `map.json`. This way the skill stays useful without the app, the app opens maps made by any version of the skill it understands, and a change in one piece does not force a release of the other.

## Where the skill lives

`skill/` in this repo is the source of the skill. `~/.claude/skills/flow-map`, which `./install` creates (copied or linked), is a deployment of it. The app runs `init` from its own copy in `skill/`, while the prompts it gives Claude use the path of the installed skill.

## Considered Options

- **A single package with the app inside the skill:** rejected because the app needs a persistent server and window and its own release cycle, and the skill must stay a directory of instructions and scripts.
- **The app calls the skill's scripts:** rejected because it ties the app to Python and to the skill's install path.

## Consequences

- The schema of the map folder has to stay compatible; an incompatible change raises `version`, and the app warns when it does not understand a folder.
- Both pieces read and write the same files, so the app reloads when they change and never assumes it is the only writer.

## A second contract, without a version

Besides the format of the map folder, the app depends on three things in the skill that carry no version:

- **Its CLI `add`, `update`, `html`, `link` and `check`.** The "New screen" (`src/new-screen.ts`), "Capture" (`src/capture-new.ts`) and "Re-capture" (`src/recapture.ts`) requests ask Claude to run `flowmap.py add` (with `--id`, `--title`, `--flow`, `--image`, `--from`, `--action`, `--description`; it also accepts `--html`), `update` (with `--id` and `--image`), `html` (with `--id` and `--file`: it copies the HTML to `screens-src/<id>.html`, sets the `html` key and rejects files that are not self-contained), `link` (only the transition, for a screen the map already has) and `check`. The skill's install path is written in `src/skill-command.ts` (`FLOW_MAP_COMMAND`), and the permission rules the app suggests come from it too. The app no longer edits the `html` key of `map.json` by hand: the skill sets it.
- **The text of the comments export,** copied from the skill into `src/annotations.ts` (the format of `temp/annotations.json` and the text of `export`).
- **Its `init`, which the app runs from its own copy in `skill/`** (`src/scratch-map.ts`) to create the working map; the prompts the app gives Claude, on the other hand, use the path of the installed skill.

The `version` field of `map.json` does not cover this contract: if the skill changes a subcommand, a flag, its path or the text of the export, the app fails without warning. A change to the skill's CLI is made together with `src/new-screen.ts`, `src/recapture.ts`, `src/skill-command.ts` and `src/annotations.ts`. The decision above does not change: there is still no shared code.
