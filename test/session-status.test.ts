import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { homeOnlyMap } from "./map-fixtures.ts";
import { createFixtures, linkTo, textClient, TOKEN, waitFor } from "./support.ts";

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
const fixtures = createFixtures();
const { startFakeSession, buildMapFolder } = fixtures;
const { send } = textClient(() => server!.port);

afterEach(async () => {
  await server?.close();
  server = undefined;
  await fixtures.closeFakes();
  await fixtures.removeTempDirs();
});

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

describe("the state of the linked session", () => {
  it("reports alive true when the session socket accepts a connection and false when it is missing or refuses, writes nothing to it, keeps {linked: false} for unlinked maps and never exposes the token", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
    const session = await startFakeSession();
    const folder = await buildMapFolder(homeOnlyMap());
    await openMap(folder);

    const unlinked = await send("GET", "/__flowmap-app/session");
    await linkTo(dataDir, folder, session.socket);
    const alive = await send("GET", "/__flowmap-app/session");
    await waitFor(() => session.messages.length === 1, "the session to receive the connection check");
    await linkTo(dataDir, folder, join(session.dir, "gone.sock"));
    const missing = await send("GET", "/__flowmap-app/session");
    const staleSocket = join(session.dir, "stale.sock");
    await writeFile(staleSocket, "");
    await linkTo(dataDir, folder, staleSocket);
    const refusing = await send("GET", "/__flowmap-app/session");

    expect(JSON.parse(unlinked.body)).toEqual({ linked: false });
    expect(JSON.parse(alive.body)).toEqual({ linked: true, socket: "s.sock", alive: true });
    expect(JSON.parse(missing.body)).toEqual({ linked: true, socket: "gone.sock", alive: false });
    expect(JSON.parse(refusing.body)).toEqual({ linked: true, socket: "stale.sock", alive: false });
    expect(session.connections()).toBe(1);
    expect(session.messages).toEqual([""]);
    for (const reply of [unlinked, alive, missing, refusing]) {
      expect(reply.body).not.toContain(TOKEN);
      expect(reply.body).not.toContain(session.dir);
    }
  });

  it("shows a map as linked only when the link file for its real path is in the app's data dir: a session.json left in the map folder, or the link of another folder, does not count, and the answer never carries the token or the socket's directory", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
    const session = await startFakeSession();
    const folder = await buildMapFolder(homeOnlyMap());
    const otherFolder = await buildMapFolder(homeOnlyMap("Other"));
    await openMap(folder);

    await writeFile(join(folder, "session.json"), JSON.stringify({ version: 1, socket: session.socket, token: TOKEN, linkedAt: "2026-11-05T10:00:00.000Z" }));
    const legacyOnly = await send("GET", "/__flowmap-app/session");
    await linkTo(dataDir, otherFolder, session.socket);
    const linkedElsewhere = await send("GET", "/__flowmap-app/session");
    await linkTo(dataDir, folder, session.socket);
    const linked = await send("GET", "/__flowmap-app/session");

    expect(JSON.parse(legacyOnly.body)).toEqual({ linked: false });
    expect(JSON.parse(linkedElsewhere.body)).toEqual({ linked: false });
    expect(JSON.parse(linked.body)).toEqual({ linked: true, socket: "s.sock", alive: true });
    for (const reply of [legacyOnly, linkedElsewhere, linked]) {
      expect(reply.body).not.toContain(TOKEN);
      expect(reply.body).not.toContain(session.dir);
    }
  });

  it("answers 404 with no map open and, for the open map, plain-language {settings, steps} that name its folder and the settings to change, without the token or the socket path", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
    const noMap = await send("GET", "/__flowmap-app/session-help");
    const session = await startFakeSession();
    const folder = await buildMapFolder(homeOnlyMap());
    await linkTo(dataDir, folder, session.socket);
    await openMap(folder);

    const help = await send("GET", "/__flowmap-app/session-help");

    expect(noMap.status).toBe(404);
    expect(JSON.parse(noMap.body)).toEqual({ error: expect.any(String) });
    expect(help.status).toBe(200);
    const { settings, steps } = JSON.parse(help.body) as { settings: string; steps: string[] };
    expect(typeof settings).toBe("string");
    expect(steps.length).toBeGreaterThan(0);
    const text = [settings, ...steps].join("\n");
    expect(text).toContain('"crossSessionInbound": "accept"');
    expect(text).toContain("settings.json");
    expect(text).toContain(folder);
    expect(text).toMatch(/flow-map/);
    expect(text).toMatch(/never[^.]*approve[^.]*permission/i);
    expect(text).toMatch(/never[^.]*change[^.]*settings/i);
    expect(help.body).not.toContain(TOKEN);
    expect(help.body).not.toContain(session.socket);
    expect(help.body).not.toContain(session.dir);
  });
});
