import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { fourScreenMap } from "./map-fixtures.ts";
import { createFixtures, linkTo, textClient, TOKEN, unlink, waitFor } from "./support.ts";

const run = promisify(execFile);
const FLOWMAP_ADD = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py add ";
const FLOWMAP_HTML = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py html ";
const FLOWMAP_CHECK = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py check ";

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
let dataDir: string;
const fixtures = createFixtures();
const { startFakeSession, startFakeClaude, buildMapFolder } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

beforeEach(async () => {
  dataDir = await fixtures.makeTempDir("flow-map-data-");
});

afterEach(async () => {
  await fixtures.closeFakes(); // releases fake CLIs and kills leftovers before the server closes
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

const newScreen = (body: unknown, headers: Record<string, string> = {}) => fromPage("POST", "/__flowmap-app/new-screen", body, headers);
const ask = (body: unknown) => fromPage("POST", "/__flowmap-app/request", body);

async function openMap(folder: string, options: { claudeBin?: string } = {}) {
  server = await createServer({ port: 0, dataDir, ...options });
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

async function openLinkedMap(options: { claudeBin?: string } = {}) {
  const session = await startFakeSession();
  const folder = await buildMapFolder(fourScreenMap());
  await linkTo(dataDir, folder, session.socket);
  await openMap(folder, options);
  return { session, folder };
}

/** The user message text of what a session received (after checking the auth line). */
function userText(raw: string): string {
  expect(raw.endsWith("\n"), "every line ends with a newline").toBe(true);
  const lines = raw.slice(0, -1).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(`{"type":"auth","token":"${TOKEN}"}`);
  return (JSON.parse(lines[1]!) as { message: { content: string } }).message.content;
}

/** Runs the `flowmap.py add` line of the prompt through a shell with the command swapped for printf: what Claude's shell would pass as arguments. */
async function addArguments(prompt: string): Promise<{ folder: string; flags: Record<string, string> }> {
  const line = prompt.split("\n").map((candidate) => candidate.trim()).find((candidate) => candidate.startsWith(FLOWMAP_ADD));
  expect(line, "the prompt has the flowmap.py add command on one line").toBeDefined();
  const { stdout } = await run("sh", ["-c", `printf '%s\\n' ${line!.slice(FLOWMAP_ADD.length)}`]);
  const [folder, ...rest] = stdout.slice(0, -1).split("\n");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i]!] = rest[i + 1]!;
  return { folder: folder!, flags };
}

describe("asking for a new screen", () => {
  it("delivers the new-screen prompt to the linked session with the unique id, the absolute captures, the render rule, a flowmap.py add line a shell parses back to the exact values, the flowmap.py html line that registers the mock (after the add lines, before check, no hand edit of map.json) and the flowmap.py check line, and leaves out --from and --action without a `from`", async () => {
    const { session, folder } = await openLinkedMap();
    const real = await realpath(folder);
    const title = `Owner's "offer" $HOME`;
    const description = "Shows a `discount` with $(whoami) & more";
    const action = "tap «Offers» & wait";

    const withFrom = await newScreen({ title, description, from: "a2-detail", action });
    const withoutFrom = await newScreen({ title: "New offer", description: "Plain" });

    expect(withFrom.status).toBe(200);
    expect(JSON.parse(withFrom.body)).toEqual({ sent: true });
    expect(JSON.parse(withoutFrom.body)).toEqual({ sent: true });
    await waitFor(() => session.messages.length === 2, "the session to receive both prompts");
    const [first, second] = session.messages.map(userText) as [string, string];

    for (const part of [
      "Checkout flow",
      "owners-offer-home",
      `${real}/screens-src`,
      `file://${real}/screens-src/owners-offer-home.html`,
      "--viewport-size=1280,800",
      "a2-detail",
      "main",
      `${real}/screens/a2-detail.png`,
      `${real}/screens/a1-home.png`,
      `${real}/screens/a3-cart.png`,
    ]) {
      expect(first, part).toContain(part);
    }
    expect(first, "a screen of another flow is not a neighbour").not.toContain(`${real}/screens/new-offer.png`);
    expect(await addArguments(first)).toEqual({
      folder: real,
      flags: {
        "--id": "owners-offer-home",
        "--title": title,
        "--flow": "main",
        "--image": "screens-src/owners-offer-home.png",
        "--from": "a2-detail",
        "--action": action,
        "--description": description,
      },
    });

    const promptLines = first.split("\n").map((line) => line.trim());
    const lastAdd = promptLines.findLastIndex((line) => line.startsWith(FLOWMAP_ADD));
    const htmlStep = promptLines.findIndex((line) => line.startsWith(FLOWMAP_HTML));
    expect(htmlStep, "the prompt has the flowmap.py html command on one line").toBeGreaterThan(-1);
    const { stdout: htmlArguments } = await run("sh", ["-c", `printf '%s\\n' ${promptLines[htmlStep]!.slice(FLOWMAP_HTML.length)}`]);
    expect(htmlArguments, "html registers the mock of the new screen on the real folder path").toBe(
      `${real}\n--id\nowners-offer-home\n--file\n${real}/screens-src/owners-offer-home.html\n`,
    );
    expect(htmlStep, "the html step comes after the last add line").toBeGreaterThan(lastAdd);
    expect(
      promptLines.filter((line) => /edit/i.test(line) && line.includes("map.json")),
      "no instruction to edit map.json by hand remains",
    ).toEqual([]);
    const checkLine = promptLines.findIndex((line) => line.startsWith(FLOWMAP_CHECK));
    expect(checkLine, "the prompt has the flowmap.py check command on one line").toBeGreaterThan(htmlStep);
    const { stdout: checkArguments } = await run("sh", ["-c", `printf '%s\\n' ${promptLines[checkLine]!.slice(FLOWMAP_CHECK.length)}`]);
    expect(checkArguments, "check runs on the real folder path").toBe(`${real}\n`);

    const aloneRule = promptLines.find((line) => line.includes("&&"));
    expect(aloneRule, "the prompt tells Claude to run each shell command alone, naming the chaining it must not do").toBeDefined();
    for (const part of ["cd", ";", "|", "python -c", "node -e", "Read"]) expect(aloneRule, part).toContain(part);

    expect(second, "the slug new-offer is taken, so the id gets -2").toContain("new-offer-2");
    expect(second, "the web map's default viewport").toContain("--viewport-size=1440,900");
    expect(await addArguments(second)).toEqual({
      folder: real,
      flags: {
        "--id": "new-offer-2",
        "--title": "New offer",
        "--flow": "main",
        "--image": "screens-src/new-offer-2.png",
        "--description": "Plain",
      },
    });
  });

  it("starts a worker run with the same prompt and the folder rules plus the playwright screenshot rule, answers 202 {runId, via}, and answers 409 without starting anything while a run is in progress", async () => {
    const fake = await startFakeClaude({ mode: "success", hold: true });
    const folder = await buildMapFolder(fourScreenMap()); // not linked: the worker does not need a session
    await openMap(folder, { claudeBin: fake.bin });

    const reply = await newScreen({ title: "Checkout summary", from: "a2-detail", action: "tap «Pay»", via: "worker" });

    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ runId: expect.stringMatching(/^[0-9a-f]+$/), via: "worker" });
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");
    const { argv } = (await fake.calls())[0]!;
    expect(argv[0]).toBe("-p");
    for (const part of ["Checkout flow", "checkout-summary", "a2-detail", "flowmap.py add"]) expect(argv[1], part).toContain(part);
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual([
      `Read(/${folder}/**)`,
      `Edit(/${folder}/**)`,
      "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)",
      "Bash(npx playwright screenshot *)",
    ]);

    const busy = await newScreen({ title: "Another screen", via: "worker" });

    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body)).toEqual({ error: expect.any(String) });
    await new Promise((done) => setTimeout(done, 200));
    expect(await fake.calls(), "the refused request started nothing").toHaveLength(1);
  }, 20_000);

  it("refuses with 400 {error}, 403 or 409 and delivers nothing, and shares the limit of 5 accepted requests per window with /request", async () => {
    const fake = await startFakeClaude();
    const { session, folder } = await openLinkedMap({ claudeBin: fake.bin });
    const valid = { title: "Pay screen", from: "a2-detail" };
    const invalid: { name: string; body: unknown }[] = [
      { name: "blank title", body: { ...valid, title: "   " } },
      { name: "title of 121 characters", body: { ...valid, title: "t".repeat(121) } },
      { name: "description of 4001 characters", body: { ...valid, description: "d".repeat(4001) } },
      { name: "from not in the map", body: { ...valid, from: "no-such-screen" } },
      { name: "action of 201 characters", body: { ...valid, action: "a".repeat(201) } },
      { name: "via other than worker", body: { ...valid, via: "session" } },
      { name: "worker: blank title", body: { ...valid, title: "", via: "worker" } },
    ];

    for (const { name, body } of invalid) {
      const reply = await newScreen(body);

      expect(reply.status, name).toBe(400);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
      expect(reply.body, name).not.toContain(TOKEN);
    }
    const forgeries: Record<string, Record<string, string>> = {
      "without X-Flowmap": {},
      "from another origin": { "X-Flowmap": "1", Origin: "http://evil.example" },
      "from a foreign Host": { "X-Flowmap": "1", Host: "evil.example" },
    };
    for (const [how, headers] of Object.entries(forgeries)) {
      for (const via of [undefined, "worker"]) {
        const reply = await send("POST", "/__flowmap-app/new-screen", {
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ ...valid, via }),
        });
        expect(reply.status, `${how} (via ${via ?? "session"})`).toBe(403);
      }
    }
    await unlink(dataDir, folder);
    const unlinked = await newScreen(valid);
    expect(unlinked.status, "map not linked").toBe(409);
    expect(JSON.parse(unlinked.body)).toEqual({ error: expect.any(String) });
    expect(session.connections()).toBe(0);
    expect(await fake.calls(), "no worker was started").toHaveLength(0);

    // none of the refusals above took a slot: 3 requests and 2 new screens fill the window, the next one is refused
    await linkTo(dataDir, folder, session.socket);
    const accepted = [await ask({ text: "One" }), await ask({ text: "Two" }), await ask({ text: "Three" }), await newScreen(valid), await newScreen(valid)];
    const refused = await newScreen(valid);

    expect(accepted.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect(JSON.parse(refused.body)).toEqual({ error: expect.any(String) });
    await waitFor(() => session.messages.length === 5, "the session to receive the 5 accepted messages");
    expect(session.connections()).toBe(5);
  });
});
