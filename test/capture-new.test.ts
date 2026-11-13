import { execFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { fourScreenMap } from "./map-fixtures.ts";
import { createFixtures, linkTo, textClient, TOKEN, unlink, waitFor } from "./support.ts";

const run = promisify(execFile);
const FLOWMAP_ADD = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py add ";

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
let dataDir: string;
const fixtures = createFixtures();
const { startFakeSession, startFakeClaude } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await fixtures.closeFakes(); // releases fake CLIs and kills leftovers before the server closes
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

const capture = (body: unknown) => fromPage("POST", "/__flowmap-app/capture", body);
const ask = (body: unknown) => fromPage("POST", "/__flowmap-app/request", body);

async function openFolder(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

async function startApp(options: { claudeBin?: string } = {}) {
  dataDir = await fixtures.makeTempDir("flow-map-data-");
  server = await createServer({ port: 0, dataDir, ...options });
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

describe("asking to capture what is on the device now as a new screen", () => {
  it("delivers the capture prompt to the linked session for an ios map and a web map: the unique id, title, platform recipe, the note verbatim, the absolute capture path, the rules to leave a bad capture out, and a flowmap.py add line a shell parses back to the exact values, with the flow of the `from` screen or else of the entry screen", async () => {
    const title = `Owner's "offer" $HOME`;
    const note = `Open it from the "Offers" tab $(whoami)\nsecond line 'quoted' & more`;
    const action = "tap «Offers» & wait";
    const cases = [
      { platform: "ios" as const, present: ["agent-device"], absent: ["playwright"] },
      { platform: "web" as const, present: ["npx playwright screenshot --viewport-size=1440,900", "ask the designer"], absent: ["agent-device"] },
    ];

    for (const { platform, present, absent } of cases) {
      const session = await startFakeSession();
      const folder = await fixtures.buildMapFolder(fourScreenMap(platform));
      await startApp();
      await linkTo(dataDir, folder, session.socket);
      await openFolder(folder);
      const real = await realpath(folder);

      const withFrom = await capture({ title, from: "new-offer", action, note }); // new-offer is the only screen of the flow "extras"
      const withoutFrom = await capture({ title: "New offer" });

      expect(withFrom.status, platform).toBe(200);
      expect(JSON.parse(withFrom.body), platform).toEqual({ sent: true });
      expect(withoutFrom.status, platform).toBe(200);
      await waitFor(() => session.messages.length === 2, `the ${platform} session to receive both prompts`);
      const [first, second] = session.messages.map(userText) as [string, string];

      for (const part of [
        "Checkout flow",
        "owners-offer-home",
        title,
        `Platform: ${platform}`,
        "Designer's note",
        note,
        `${real}/screens-src/owners-offer-home.capture.png`,
        "Read",
        "blank",
        "clipped",
        "identical",
        "flowmap.py link",
        ...present,
      ]) {
        expect(first, `${platform}: ${part}`).toContain(part);
      }
      for (const part of absent) expect(first, `${platform}: no ${part}`).not.toContain(part);
      expect(await addArguments(first), platform).toEqual({
        folder: real,
        flags: {
          "--id": "owners-offer-home",
          "--title": title,
          "--flow": "extras",
          "--image": `${real}/screens-src/owners-offer-home.capture.png`,
          "--from": "new-offer",
          "--action": action,
        },
      });
      const aloneRule = first.split("\n").find((line) => line.includes("&&"));
      expect(aloneRule, `${platform}: the prompt tells Claude to run each shell command alone, naming the chaining it must not do`).toBeDefined();
      for (const part of ["cd", ";", "|", "python -c", "node -e", "Read"]) expect(aloneRule, `${platform}: ${part}`).toContain(part);

      expect(second, `${platform}: the slug new-offer is taken, so the id gets -2`).toContain(`${real}/screens-src/new-offer-2.capture.png`);
      expect(await addArguments(second), platform).toEqual({
        folder: real,
        flags: {
          "--id": "new-offer-2",
          "--title": "New offer",
          "--flow": "main", // the flow of the entry screen a1-home
          "--image": `${real}/screens-src/new-offer-2.capture.png`,
        },
      });

      await server!.close();
      server = undefined;
      await fixtures.closeFakes();
    }
  });

  it("starts a worker run with the folder rules plus the playwright screenshot rule and no agent-device rule (202 {runId, via}, 409 while a run is going), refuses with 400 {error}, 403, 404 or 409 delivering nothing, and shares the limit of 5 accepted requests per window with /request", async () => {
    const fake = await startFakeClaude({ mode: "success", hold: true });
    const session = await startFakeSession();
    const folder = await fixtures.buildMapFolder(fourScreenMap());
    await startApp({ claudeBin: fake.bin });
    await linkTo(dataDir, folder, session.socket);

    const valid = { title: "Pay screen", from: "a2-detail" };
    const noMap = await capture(valid);
    expect(noMap.status, "no map open").toBe(404);
    expect(JSON.parse(noMap.body)).toEqual({ error: expect.any(String) });
    await openFolder(folder);
    await rm(join(folder, "screens", "a3-cart.png"));

    const invalid: { name: string; body: unknown; mentions?: string }[] = [
      { name: "missing title", body: {} },
      { name: "blank title", body: { title: "   " } },
      { name: "title that is not text", body: { title: 5 } },
      { name: "title of 121 characters", body: { title: "t".repeat(121) } },
      { name: "note of 501 characters", body: { ...valid, note: "n".repeat(501) } },
      { name: "note that is not text", body: { ...valid, note: 5 } },
      { name: "action of 201 characters", body: { ...valid, action: "a".repeat(201) } },
      { name: "from not in the map", body: { ...valid, from: "no-such-screen" } },
      { name: "from whose capture is missing from the folder", body: { ...valid, from: "a3-cart" }, mentions: "a3-cart" },
      { name: "via other than worker", body: { ...valid, via: "session" } },
      { name: "worker: from not in the map", body: { ...valid, from: "no-such-screen", via: "worker" } },
    ];
    for (const { name, body, mentions } of invalid) {
      const reply = await capture(body);

      expect(reply.status, name).toBe(400);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
      if (mentions) expect(JSON.parse(reply.body).error, name).toContain(mentions);
      expect(reply.body, name).not.toContain(TOKEN);
    }
    const forgeries: Record<string, Record<string, string>> = {
      "without X-Flowmap": {},
      "from another origin": { "X-Flowmap": "1", Origin: "http://evil.example" },
      "from a foreign Host": { "X-Flowmap": "1", Host: "evil.example" },
    };
    for (const [how, headers] of Object.entries(forgeries)) {
      for (const via of [undefined, "worker"]) {
        const reply = await send("POST", "/__flowmap-app/capture", {
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ ...valid, via }),
        });
        expect(reply.status, `${how} (via ${via ?? "session"})`).toBe(403);
      }
    }
    await unlink(dataDir, folder);
    const unlinked = await capture(valid);
    expect(unlinked.status, "map not linked").toBe(409);
    expect(JSON.parse(unlinked.body)).toEqual({ error: expect.any(String) });
    expect(session.connections()).toBe(0);
    expect(await fake.calls(), "nothing was delivered by the refusals").toHaveLength(0);

    // none of the refusals above took a slot: the worker run, 3 requests and 1 capture (with the limits exactly) fill the window
    await linkTo(dataDir, folder, session.socket);
    const worker = await capture({ ...valid, via: "worker" });

    expect(worker.status).toBe(202);
    expect(JSON.parse(worker.body)).toEqual({ runId: expect.stringMatching(/^[0-9a-f]+$/), via: "worker" });
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");
    const { argv } = (await fake.calls())[0]!;
    expect(argv[0]).toBe("-p");
    for (const part of ["Checkout flow", "pay-screen", "flowmap.py add"]) expect(argv[1], part).toContain(part);
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual([
      `Read(/${folder}/**)`,
      `Edit(/${folder}/**)`,
      "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)",
      "Bash(npx playwright screenshot *)",
    ]);

    const busy = await capture({ ...valid, via: "worker" });

    expect(busy.status, "a run is already going").toBe(409);
    expect(JSON.parse(busy.body)).toEqual({ error: expect.any(String) });
    await new Promise((done) => setTimeout(done, 200));
    expect(await fake.calls(), "the refused request started nothing").toHaveLength(1);

    const accepted = [
      await ask({ text: "One" }),
      await ask({ text: "Two" }),
      await ask({ text: "Three" }),
      await capture({ title: "t".repeat(120), from: "a2-detail", action: "a".repeat(200), note: "n".repeat(500) }),
    ];
    const refused = await capture(valid);

    expect(accepted.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect(JSON.parse(refused.body)).toEqual({ error: expect.any(String) });
    await waitFor(() => session.messages.length === 4, "the session to receive the 4 accepted messages");
    expect(session.connections()).toBe(4);
  }, 20_000);
});
