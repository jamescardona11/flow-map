import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap, screenOf } from "./map-fixtures.ts";
import { createFixtures, linkTo, textClient, TOKEN, waitFor, type FakeSession } from "./support.ts";

const run = promisify(execFile);
const FLOWMAP_ADD = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py add ";
const MAX_DESIGN_LENGTH = 50_000;

type Reply = { status: number; body: string };
type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
const fixtures = createFixtures();
const { startFakeSession } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await fixtures.closeFakes();
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

const getDesign = () => send("GET", "/__flowmap-app/design");
const putDesign = (body: unknown, headers: Record<string, string> = {}) => fromPage("PUT", "/__flowmap-app/design", body, headers);
const newScreen = (body: unknown) => fromPage("POST", "/__flowmap-app/new-screen", body);

/** Two screens in the flow "main" (the entry is a1-home). */
const buildDesignMapFolder = () =>
  fixtures.buildMapFolder(
    checkoutMap({
      fingerprint: "test-fingerprint",
      screens: [screenOf("a1-home", { width: 1440, height: 900 }), screenOf("a2-detail", { width: 1280, height: 800 })],
    }),
  );

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

async function openLinkedMap(): Promise<{ session: FakeSession; folder: string }> {
  const session = await startFakeSession();
  const folder = await buildDesignMapFolder();
  const dataDir = await fixtures.makeTempDir("flow-map-data-");
  await linkTo(dataDir, folder, session.socket);
  server = await createServer({ port: 0, dataDir });
  await openMap(folder);
  return { session, folder };
}

/** The user message text of what a session received (after checking the auth line). */
function userText(raw: string): string {
  const lines = raw.slice(0, -1).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(`{"type":"auth","token":"${TOKEN}"}`);
  return (JSON.parse(lines[1]!) as { message: { content: string } }).message.content;
}

/** Every `flowmap.py add` line of the prompt, run through a shell with the command swapped for printf: what Claude's shell would pass as arguments. */
async function addCommands(prompt: string): Promise<{ folder: string; flags: Record<string, string> }[]> {
  const lines = prompt.split("\n").map((candidate) => candidate.trim()).filter((candidate) => candidate.startsWith(FLOWMAP_ADD));
  return Promise.all(
    lines.map(async (line) => {
      const { stdout } = await run("sh", ["-c", `printf '%s\\n' ${line.slice(FLOWMAP_ADD.length)}`]);
      const [folder, ...rest] = stdout.slice(0, -1).split("\n");
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 2) flags[rest[i]!] = rest[i + 1]!;
      return { folder: folder!, flags };
    }),
  );
}

describe("the design contract of a map", () => {
  it("keeps the contract in DESIGN.md through GET and PUT: reports exists false when there is none, saves, replaces and removes it on blank text, writes nothing else in the folder, and refuses with 404, 403 and 400", async () => {
    server = await createServer({ port: 0 });
    expect((await getDesign()).status, "GET with no map open").toBe(404);
    const noMap = await putDesign({ text: "x" });
    expect(noMap.status, "PUT with no map open").toBe(404);
    expect(JSON.parse(noMap.body)).toEqual({ error: expect.any(String) });

    const folder = await buildDesignMapFolder();
    await openMap(folder);
    const before = (await readdir(folder)).sort();
    expect(JSON.parse((await getDesign()).body)).toEqual({ exists: false, text: "" });

    const saved = await putDesign({ text: "# Look\nInk #111, Inter 16px" });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toEqual({ exists: true });
    expect(JSON.parse((await getDesign()).body)).toEqual({ exists: true, text: "# Look\nInk #111, Inter 16px" });
    expect(await readFile(join(folder, "DESIGN.md"), "utf8")).toBe("# Look\nInk #111, Inter 16px");
    expect((await readdir(folder)).sort(), "only DESIGN.md was added: no temp file is left").toEqual([...before, "DESIGN.md"].sort());

    expect((await putDesign({ text: "x".repeat(MAX_DESIGN_LENGTH) })).status, "the limit itself is accepted").toBe(200);
    const refusals: [string, Reply][] = [
      ["a text over the limit", await putDesign({ text: "x".repeat(MAX_DESIGN_LENGTH + 1) })],
      ["a text that is not a string", await putDesign({ text: 42 })],
      ["a body with no text", await putDesign({})],
    ];
    for (const [name, reply] of refusals) {
      expect(reply.status, name).toBe(400);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
    }
    const forgeries: Record<string, Record<string, string>> = {
      "without X-Flowmap": { "X-Flowmap": "" },
      "from another origin": { Origin: "http://evil.example" },
    };
    for (const [how, headers] of Object.entries(forgeries)) {
      const forged = await send("PUT", "/__flowmap-app/design", {
        headers: { "X-Flowmap": "1", "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ text: "forged" }),
      });
      expect(forged.status, how).toBe(403);
    }
    expect((JSON.parse((await getDesign()).body) as { text: string }).text, "no refusal changed the file").toBe("x".repeat(MAX_DESIGN_LENGTH));

    const removed = await putDesign({ text: "  \n " });
    expect(removed.status).toBe(200);
    expect(JSON.parse(removed.body)).toEqual({ exists: false });
    expect(JSON.parse((await getDesign()).body)).toEqual({ exists: false, text: "" });
    expect((await readdir(folder)).sort(), "the file is gone").toEqual(before);
    const again = await putDesign({ text: "" });
    expect(again.status, "blank text with no file").toBe(200);
    expect(JSON.parse(again.body)).toEqual({ exists: false });
  });

  it("puts the full DESIGN.md text in a 'Design contract of this map' section of the new-screen prompt and says to follow it over the neighbours, and, when there is none, says there is no contract and to infer the look from the neighbouring captures", async () => {
    const { session } = await openLinkedMap();
    const contract = "Colours: ink `#111` on $(whoami) 'paper' & \"white\"\nFonts: Inter, 16px/24px\nComponents: pill buttons";
    expect((await putDesign({ text: contract })).status).toBe(200);

    expect((await newScreen({ title: "Pay screen", from: "a2-detail" })).status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the first prompt");
    const withContract = userText(session.messages[0]!);

    const section = withContract.indexOf("Design contract of this map");
    expect(section, "the prompt has the section").toBeGreaterThanOrEqual(0);
    expect(withContract.indexOf(contract), "the whole text comes after the section title").toBeGreaterThan(section);
    expect(withContract).toMatch(/follow/i);
    expect(withContract, "the contract wins over copying neighbours").toMatch(/takes precedence/i);

    expect((await putDesign({ text: "" })).status).toBe(200);
    expect((await newScreen({ title: "Pay screen", from: "a2-detail" })).status).toBe(200);
    await waitFor(() => session.messages.length === 2, "the second prompt");
    const withoutContract = userText(session.messages[1]!);

    expect(withoutContract).not.toContain("Design contract of this map");
    expect(withoutContract).toMatch(/no design contract/i);
    expect(withoutContract).toMatch(/infer the look from the neighbouring captures/i);
  });

  it("asks for four states and a verification: one HTML selected by #state=<name>, one PNG per state, four flowmap.py add lines that a shell parses back to the exact values (normal linked from `from`, the other three linked from the normal one), and a Read-and-report step; without `from` the normal state has no --from or --action", async () => {
    const { session, folder } = await openLinkedMap();
    const real = await realpath(folder);
    const title = `Owner's "offer" $HOME`;
    const description = "Shows a `discount` with $(whoami) & more";
    const action = "tap «Offers» & wait";
    const id = "owners-offer-home";

    expect((await newScreen({ title, description, from: "a2-detail", action })).status).toBe(200);
    expect((await newScreen({ title: "Plain screen" })).status).toBe(200);
    await waitFor(() => session.messages.length === 2, "both prompts");
    const [withFrom, withoutFrom] = session.messages.map(userText) as [string, string];

    for (const state of ["normal", "empty", "loading", "error"]) {
      expect(withFrom, `the HTML is selected by #state=${state}`).toContain(`file://${real}/screens-src/${id}.html#state=${state}`);
    }
    for (const png of [`${id}.png`, `${id}.empty.png`, `${id}.loading.png`, `${id}.error.png`]) {
      expect(withFrom, png).toContain(`${real}/screens-src/${png}`);
    }
    expect(withFrom, "a verification step reads each PNG").toMatch(/Read/);
    expect(withFrom).toMatch(/verification report/i);
    expect(withFrom).toMatch(/one line per state/i);

    const otherStates = (name: string, of: string, flow: string, ownTitle: string) => ({
      "--id": `${of}-${name}`,
      "--title": `${ownTitle} (${name})`,
      "--flow": flow,
      "--image": `screens-src/${of}.${name}.png`,
      "--from": of,
      "--action": `state: ${name}`,
      "--description": `${name} state of ${ownTitle}`,
    });
    expect(await addCommands(withFrom)).toEqual([
      {
        folder: real,
        flags: {
          "--id": id,
          "--title": title,
          "--flow": "main",
          "--image": `screens-src/${id}.png`,
          "--from": "a2-detail",
          "--action": action,
          "--description": description,
        },
      },
      ...["empty", "loading", "error"].map((name) => ({ folder: real, flags: otherStates(name, id, "main", title) })),
    ]);

    expect(await addCommands(withoutFrom)).toEqual([
      {
        folder: real,
        flags: { "--id": "plain-screen", "--title": "Plain screen", "--flow": "main", "--image": "screens-src/plain-screen.png" },
      },
      ...["empty", "loading", "error"].map((name) => ({ folder: real, flags: otherStates(name, "plain-screen", "main", "Plain screen") })),
    ]);
  });
});
