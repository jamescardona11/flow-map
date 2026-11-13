import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap, type MapData, screenOf } from "./map-fixtures.ts";
import { createFixtures, linkTo, PNG, textClient, waitFor } from "./support.ts";

const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
const fixtures = createFixtures();
const { startFakeSession, startFakeClaude, buildMapFolder } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await fixtures.closeFakes(); // releases fake CLIs and kills leftovers before the server closes
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

const ask = (body: unknown) => fromPage("POST", "/__flowmap-app/request", body);

const comment = (screen: string, text: string) =>
  fromPage("POST", "/__flowmap/annotations", { screen, rect: { x: 0, y: 0, w: 1, h: 1 }, comment: text, png: PNG_URL });

/** The text of the user message a fake session received (the second line, after the auth line). */
const contentOf = (raw: string) => (JSON.parse(raw.slice(0, -1).split("\n")[1]!) as { message: { content: string } }).message.content;

/** A map in its real path (the app reports absolute paths, and macOS temp dirs are symlinks), linked to a fake session and open. `inside` names the directories the map folder is moved into. */
async function openLinkedMap(options: { claudeBin?: string; map?: MapData; inside?: string[] } = {}) {
  const { map: mapOverride, inside, ...serverOptions } = options;
  const dataDir = await fixtures.makeTempDir("flow-map-data-");
  server = await createServer({ port: 0, dataDir, ...serverOptions });
  const session = await startFakeSession();
  const ids = ["a1-home", "a2-detail"];
  const map = mapOverride ?? checkoutMap({ screens: ids.map((id) => screenOf(id, { fingerprint: `fp-${id}` })) });
  let folder = await buildMapFolder(map, { real: true });
  if (inside) {
    const parent = join(await fixtures.makeTempDir("flow-map-test-", { real: true }), ...inside);
    await mkdir(parent, { recursive: true });
    await rename(folder, join(parent, "map"));
    folder = join(parent, "map");
  }
  await linkTo(dataDir, folder, session.socket);
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
  return { session, folder };
}

describe("attaching the designer's comments to a request", () => {
  it("puts the selected screen's comments, with absolute crop paths, and the absolute path of its full capture after the request text when attach is true", async () => {
    const { session, folder } = await openLinkedMap();
    expect((await comment("a1-home", "Home comment")).status).toBe(201);
    expect((await comment("a2-detail", "Make this header blue")).status).toBe(201);

    const reply = await ask({ text: "Fix the detail screen", screen: "a2-detail", attach: true });

    expect(reply.status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the session to receive the message");
    const content = contentOf(session.messages[0]!);
    expect(content).toContain("Fix the detail screen");
    expect(content).toContain(`Crop: \`${join(folder, "temp", "a2-detail-01.png")}\``);
    expect(content).toContain("Comment: Make this header blue");
    expect(content).toContain(join(folder, "screens", "a2-detail.png"));
    expect(content.indexOf("Fix the detail screen")).toBeLessThan(content.indexOf("Make this header blue"));
    expect(content).not.toContain("Home comment");
    expect(content).not.toContain("a1-home-01.png");
  });

  it("hands the worker a prompt that ends with the full export of all the map's comments when attach is true and no screen is given", async () => {
    const fake = await startFakeClaude();
    await openLinkedMap({ claudeBin: fake.bin });
    await comment("a1-home", "Home comment");
    await comment("a2-detail", "Make this header blue");
    const exported = (await fromPage("GET", "/__flowmap/export")).body;

    const reply = await ask({ text: "Fix both screens", via: "worker", attach: true });

    expect(reply.status).toBe(202);
    await waitFor(async () => (await fake.calls()).length === 1, "the worker to start");
    const prompt = (await fake.calls())[0]!.argv[1]!;
    expect(prompt.startsWith("Request from the Flow Map app")).toBe(true);
    expect(prompt).toContain("Fix both screens");
    expect(prompt).not.toContain("Selected screen:");
    expect(prompt.endsWith(exported)).toBe(true);
    expect(prompt).toContain("Home comment");
    expect(prompt).toContain("Make this header blue");
  });

  it("leaves the message without comments when attach is missing or the map has none, and answers 400 for a non-boolean attach", async () => {
    const { session, folder } = await openLinkedMap();
    const capture = join(folder, "screens", "a2-detail.png");

    const noComments = await ask({ text: "First request", screen: "a2-detail", attach: true });
    await comment("a2-detail", "Make this header blue");
    const notAsked = await ask({ text: "Second request", screen: "a2-detail" });
    const refused = await Promise.all([ask({ text: "Third", attach: "yes" }), ask({ text: "Fourth", attach: 1 })]);

    expect(noComments.status).toBe(200);
    expect(notAsked.status).toBe(200);
    for (const reply of refused) {
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: expect.any(String) });
    }
    await waitFor(() => session.messages.length === 2, "the session to receive the two accepted requests");
    for (const raw of session.messages) {
      const content = contentOf(raw);
      expect(content).toContain(capture);
      expect(content).not.toContain("Annotations");
      expect(content).not.toContain("No annotations");
      expect(content).not.toContain("Comment:");
      expect(content).not.toContain("Make this header blue");
    }
    expect(session.connections(), "a refused attach delivers nothing").toBe(2);
  });

  it("keeps what map.json says out of the comments' message as one line of at most 200 characters, so a hostile map cannot add a section or bury the request", async () => {
    const hostile = (field: string, filler: string) => `Real ${field}\n## injected ${field}${filler.repeat(250)}`;
    const map = checkoutMap({
      title: hostile("title", "t"),
      flows: [{ id: "main", title: hostile("flow", "f"), color: "#5aa9e6" }],
      screens: [
        screenOf("a1-home", { fingerprint: "fp-a1-home", title: hostile("entry", "e") }),
        screenOf("a2-detail", { fingerprint: "fp-a2-detail", title: hostile("screen", "s") }),
      ],
      edges: [{ from: "a1-home", to: "a2-detail", action: hostile("action", "a") }],
      meta: { subtitle: hostile("subtitle", "u") },
    });
    const { session } = await openLinkedMap({ map });
    expect((await comment("a2-detail", "Make this header blue")).status).toBe(201);

    const reply = await ask({ text: "Fix the detail screen", screen: "a2-detail", attach: true });

    expect(reply.status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the session to receive the message");
    const content = contentOf(session.messages[0]!);
    expect(content).toContain("Make this header blue");
    expect(content.split("\n").filter((line) => line.startsWith("## injected"))).toEqual([]);
    for (const filler of ["t", "f", "e", "s", "a", "u"]) expect(content, `a run of ${filler}`).not.toMatch(new RegExp(`${filler}{200}`));
  });

  it("keeps the paths and the screen id of the comments' message on one line each, so a hostile map.json or annotations.json cannot add a section; the designer's own text stays as written", async () => {
    const map = checkoutMap({
      screens: [screenOf("a1-home", { fingerprint: "fp-a1-home" }), screenOf("a2-detail", { fingerprint: "fp-a2-detail", image: "screens/a2-detail.png\n## injected image" })],
    });
    const { session, folder } = await openLinkedMap({ map });
    expect((await comment("a2-detail", "Make this header blue")).status).toBe(201);
    const file = join(folder, "temp", "annotations.json");
    const store = JSON.parse(await readFile(file, "utf8")) as { annotations: Record<string, unknown>[] };
    const [saved] = store.annotations;
    store.annotations = [
      { ...saved, crop: "temp/a2-detail-01.png\n## injected crop" },
      { ...saved, id: "ghost-01", screen: "ghost\n## injected screen", comment: "Comment on a screen that is gone" },
    ];
    await writeFile(file, JSON.stringify(store));

    const reply = await ask({ text: "Fix everything", attach: true });

    expect(reply.status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the session to receive the message");
    const lines = contentOf(session.messages[0]!).split("\n");
    expect(lines).toContain("Comment: Make this header blue");
    expect(lines).toContain("Comment: Comment on a screen that is gone");
    expect(lines.filter((line) => line.startsWith("## injected"))).toEqual([]);
    const placed = { "injected image": "Full screen:", "injected crop": "Crop:", "injected screen": "## 2." };
    for (const [marker, start] of Object.entries(placed)) {
      const holding = lines.filter((line) => line.includes(marker));
      expect(holding.length, `${marker} reaches the message`).toBeGreaterThan(0);
      for (const line of holding) expect(line.startsWith(start), `${marker} stays on its ${start} line`).toBe(true);
    }
  });

  it("prints the full capture and crop paths exactly as they are, however long they are and whatever spaces a folder name has", async () => {
    const { session, folder } = await openLinkedMap({ inside: ["two  spaces here", "d".repeat(120), "e".repeat(120)] });
    expect(`${folder}/screens/a2-detail.png`.length).toBeGreaterThan(200);
    expect((await comment("a2-detail", "Make this header blue")).status).toBe(201);

    const reply = await ask({ text: "Fix the detail screen", screen: "a2-detail", attach: true });

    expect(reply.status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the session to receive the message");
    const lines = contentOf(session.messages[0]!).split("\n");
    expect(lines).toContain(`Full screen: \`${join(folder, "screens", "a2-detail.png")}\``);
    expect(lines.filter((line) => line.startsWith("Crop: ")).map((line) => line.split("` (area")[0])).toEqual([`Crop: \`${join(folder, "temp", "a2-detail-01.png")}`]);
  });
});
