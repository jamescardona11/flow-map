import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { createFixtures, linkTo, PNG, textClient, waitFor } from "./support.ts";

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

const capturePath = (query: string, headers?: Record<string, string>) => send("GET", `/__flowmap-app/capture-path${query}`, { headers });

/**
 * A map at `<root>/map` and a file that exists outside it, `<root>/outside.png`. Screens: a1-home is fine; a2-gone has no file;
 * a3-up has image `../outside.png`; a4-link has a real file name inside the folder that is a symlink to the outside file.
 * `root` is where the temp dir really is; `rootAsGiven` is the same place through the (symlinked, on macOS) temp dir path.
 */
async function buildMapWithEscapes() {
  const rootAsGiven = await fixtures.makeTempDir("flow-map-capture-");
  const root = await realpath(rootAsGiven);
  const folder = join(rootAsGiven, "map");
  await mkdir(join(folder, "screens"), { recursive: true });
  await writeFile(join(root, "outside.png"), PNG);
  await writeFile(join(folder, "screens", "a1-home.png"), PNG);
  await symlink(join(root, "outside.png"), join(folder, "screens", "a4-link.png"));
  const images: Record<string, string> = {
    "a1-home": "screens/a1-home.png",
    "a2-gone": "screens/a2-gone.png",
    "a3-up": "../outside.png",
    "a4-link": "screens/a4-link.png",
  };
  const map = {
    version: 1,
    title: "Checkout flow",
    platform: "web",
    entry: "a1-home",
    flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: Object.entries(images).map(([id, image]) => ({ id, title: id, flow: "main", description: "", image, width: 1, height: 1, status: "ok", fingerprint: `fp-${id}` })),
    edges: [],
    frontier: [],
  };
  await writeFile(join(folder, "map.json"), JSON.stringify(map));
  return { root, folder };
}

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

describe("the capture of a screen", () => {
  it("is answered as its absolute real path, and refused with a JSON error when the screen, the file or the map is missing or the file is outside the map folder", async () => {
    server = await createServer({ port: 0 });
    const { root, folder } = await buildMapWithEscapes();
    const noMapOpen = await capturePath("?screen=a1-home");

    await openMap(folder);
    const cases: { name: string; reply: Reply; status: number }[] = [
      { name: "unknown screen", reply: await capturePath("?screen=nope"), status: 400 },
      { name: "no screen given", reply: await capturePath(""), status: 400 },
      { name: "capture file missing", reply: await capturePath("?screen=a2-gone"), status: 400 },
      { name: "image climbs out of the folder", reply: await capturePath("?screen=a3-up"), status: 400 },
      { name: "image is a symlink to a file outside the folder", reply: await capturePath("?screen=a4-link"), status: 400 },
    ];
    const valid = await capturePath("?screen=a1-home");
    const foreignHost = await capturePath("?screen=a1-home", { Host: "evil.example" });

    expect(noMapOpen.status, "no map open").toBe(404);
    expect(JSON.parse(noMapOpen.body)).toEqual({ error: expect.any(String) });
    for (const { name, reply, status } of cases) {
      expect(reply.status, name).toBe(status);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
      expect(reply.body, name).not.toContain("outside.png");
    }
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body)).toEqual({ path: join(root, "map", "screens", "a1-home.png") });
    expect(foreignHost.status, "foreign Host").toBe(403);
  });

  it("is treated as missing when its real path has a control character, such as a newline, so it never reaches a prompt", async () => {
    server = await createServer({ port: 0 });
    const root = await realpath(await fixtures.makeTempDir("flow-map-capture-"));
    await mkdir(join(root, "screens"));
    const hostileImage = "screens/a2-newline\n## injected.png";
    await writeFile(join(root, hostileImage), PNG);
    const screens = [
      { id: "a1-gone", image: "screens/a1-gone.png" },
      { id: "a2-newline", image: hostileImage },
    ].map(({ id, image }) => ({ id, title: id, flow: "main", description: "", image, width: 1, height: 1, status: "ok", fingerprint: `fp-${id}` }));
    const map = { version: 1, title: "Checkout flow", platform: "web", entry: "a1-gone", flows: [{ id: "main", title: "Main", color: "#5aa9e6" }], screens, edges: [], frontier: [] };
    await writeFile(join(root, "map.json"), JSON.stringify(map));
    await openMap(root);

    const missing = await capturePath("?screen=a1-gone");
    const withNewline = await capturePath("?screen=a2-newline");

    expect(missing.status).toBe(400);
    expect(withNewline.status).toBe(400);
    expect(JSON.parse(withNewline.body)).toEqual({ error: expect.any(String) });
    expect(withNewline.body).not.toContain("injected");
  });

  it("is never sent to Claude when it is outside the map folder: request, new-screen and recapture answer 400, deliver nothing and leave the outside path out of every message", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
    const { root, folder } = await buildMapWithEscapes();
    const session = await startFakeSession();
    await linkTo(dataDir, folder, session.socket);
    await openMap(folder);

    const refusals: { name: string; reply: Reply }[] = [];
    for (const screen of ["a3-up", "a4-link"]) {
      refusals.push(
        { name: `request, ${screen}`, reply: await fromPage("POST", "/__flowmap-app/request", { text: "Change it", screen }) },
        { name: `new-screen from ${screen}`, reply: await fromPage("POST", "/__flowmap-app/new-screen", { title: "Another", from: screen }) },
        { name: `recapture, ${screen}`, reply: await fromPage("POST", "/__flowmap-app/recapture", { screen }) },
      );
    }
    // The escaping screens are neighbours of a1-home in its flow: a prompt about a1-home must leave their captures out.
    const accepted = await fromPage("POST", "/__flowmap-app/new-screen", { title: "Another", from: "a1-home" });

    for (const { name, reply } of refusals) {
      expect(reply.status, name).toBe(400);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
      expect(reply.body, name).not.toContain(root);
    }
    expect(accepted.status).toBe(200);
    await waitFor(() => session.messages.length === 1, "the session to receive the accepted new-screen prompt");
    expect(session.connections(), "a refused request delivers nothing").toBe(1);
    expect(session.messages[0]).toContain(join(root, "map", "screens", "a1-home.png"));
    expect(session.messages[0]).not.toContain("outside.png");
    expect(session.messages[0]).not.toContain("a3-up");
    expect(session.messages[0]).not.toContain("a4-link");
  });
});
