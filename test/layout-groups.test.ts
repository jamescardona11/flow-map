import { readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap, screenOf } from "./map-fixtures.ts";
import { binaryClient, createFixtures, pause, until } from "./support.ts";

type Reply = { status: number; body: Buffer; contentType: string | undefined };
type Server = Awaited<ReturnType<typeof createServer>>;

const DEBOUNCE_MS = 200;
const SCREENS = ["a1-home", "a2-detail", "a3-list"];
/** Screens beyond the named ones, so a group of more than 200 members can still name screens that exist. */
const BULK_SCREENS = Array.from({ length: 210 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`);

let server: Server;
const fixtures = createFixtures();
const { send, fromPage } = binaryClient(() => server.port);
let streams: http.IncomingMessage[] = [];

beforeEach(async () => {
  server = await createServer({ port: 0, watchDebounceMs: DEBOUNCE_MS });
});

afterEach(async () => {
  streams.forEach((stream) => stream.destroy());
  streams = [];
  await server.close();
  await fixtures.removeTempDirs();
});

const openFolder = (path: string) =>
  send("POST", "/__flowmap-app/open", { headers: { "X-Flowmap": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path }) });

const json = (reply: Reply) => JSON.parse(reply.body.toString()) as unknown;

/** The screens have no capture files: these tests never read them. */
const buildDemoMapFolder = () =>
  fixtures.buildMapFolder(
    checkoutMap({ title: "Demo map", screens: [...SCREENS, ...BULK_SCREENS].map((id) => screenOf(id)), edges: [] }),
    { png: false },
  );

const readText = (folder: string, file: string) => readFile(join(folder, file), "utf8");
const filesIn = async (folder: string) => (await readdir(folder)).sort();

describe("layout and groups in the map folder", () => {
  const OTHER_FILE_TEXT = '{"kept":"as it was"}\n';

  const resources = [
    {
      name: "layout",
      file: "layout.json",
      otherFile: "groups.json",
      empty: { positions: {} },
      onDisk: {
        withStale: { positions: { "a1-home": { x: 1, y: 2 }, "gone-screen": { x: 3, y: 4 } } },
        readBack: { positions: { "a1-home": { x: 1, y: 2 } } },
      },
      valid: { positions: { "a1-home": { x: 10, y: -20.5 }, "a2-detail": { x: 0, y: 3 } } },
      validFileText: [
        "{",
        '  "positions": {',
        '    "a1-home": {',
        '      "x": 10,',
        '      "y": -20.5',
        "    },",
        '    "a2-detail": {',
        '      "x": 0,',
        '      "y": 3',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      invalid: {
        "an unknown screen": { positions: { "no-such-screen": { x: 1, y: 1 } } },
        "x as text": { positions: { "a1-home": { x: "10", y: 1 } } },
        "y as a boolean": { positions: { "a1-home": { x: 1, y: true } } },
        "x out of range": { positions: { "a1-home": { x: 1_000_001, y: 1 } } },
        "x that is not finite (NaN travels as null)": { positions: { "a1-home": { x: null, y: 1 } } },
        "a missing y": { positions: { "a1-home": { x: 1 } } },
      } as Record<string, unknown>,
    },
    {
      name: "groups",
      file: "groups.json",
      otherFile: "layout.json",
      empty: { groups: [] },
      onDisk: {
        withStale: {
          version: 1,
          groups: [
            { id: "g1", name: "Kept", members: ["a1-home", "a2-detail", "gone-screen"] },
            { id: "g2", name: "Left with one", members: ["a3-list", "gone-screen"] },
          ],
        },
        readBack: { groups: [{ id: "g1", name: "Kept", members: ["a1-home", "a2-detail"] }] },
      },
      valid: { groups: [{ id: "g1", name: "  Onboarding  ", members: ["a1-home", "a2-detail"] }] },
      validFileText: [
        "{",
        '  "version": 1,',
        '  "groups": [',
        "    {",
        '      "id": "g1",',
        '      "name": "Onboarding",',
        '      "members": [',
        '        "a1-home",',
        '        "a2-detail"',
        "      ]",
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
      invalid: {
        "a group of one member": { groups: [{ id: "g", name: "Solo", members: ["a1-home"] }] },
        "a group of 201 members": { groups: [{ id: "g", name: "Huge", members: [...SCREENS, ...BULK_SCREENS.slice(0, 198)] }] },
        "an unknown member": { groups: [{ id: "g", name: "Ghost", members: ["a1-home", "no-such-screen"] }] },
        "a screen in two groups": {
          groups: [
            { id: "g1", name: "One", members: ["a1-home", "a2-detail"] },
            { id: "g2", name: "Two", members: ["a2-detail", "a3-list"] },
          ],
        },
        "a repeated group id": {
          groups: [
            { id: "g", name: "One", members: ["a1-home", "a2-detail"] },
            { id: "g", name: "Two", members: ["a3-list", BULK_SCREENS[0]] },
          ],
        },
        "a blank name": { groups: [{ id: "g", name: "   ", members: ["a1-home", "a2-detail"] }] },
        "a name of 61 characters": { groups: [{ id: "g", name: "n".repeat(61), members: ["a1-home", "a2-detail"] }] },
        "an id of 65 characters": { groups: [{ id: "i".repeat(65), name: "Long id", members: ["a1-home", "a2-detail"] }] },
        "101 groups": {
          groups: Array.from({ length: 101 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, members: [BULK_SCREENS[2 * i]!, BULK_SCREENS[2 * i + 1]!] })),
        },
      } as Record<string, unknown>,
    },
  ];

  it("saves, reads back, validates and guards the layout and the groups in the map folder", async () => {
    for (const resource of resources) {
      const url = `/__flowmap/${resource.name}`;
      expect((await fromPage("PUT", url, resource.valid)).status, `${resource.name}: PUT with no map open`).toBe(404);
      expect((await send("GET", url)).status, `${resource.name}: GET with no map open`).toBe(404);
    }

    for (const resource of resources) {
      const { name, file, otherFile } = resource;
      const url = `/__flowmap/${name}`;
      const folder = await buildDemoMapFolder();

      await openFolder(folder);

      expect(json(await send("GET", url)), `${name}: nothing saved yet`).toEqual(resource.empty);

      await writeFile(join(folder, file), JSON.stringify(resource.onDisk.withStale));
      expect(json(await send("GET", url)), `${name}: stale entries are left out when reading`).toEqual(resource.onDisk.readBack);

      await writeFile(join(folder, file), "this is not json");
      const corrupt = await send("GET", url);
      expect(corrupt.status, `${name}: GET of a corrupt file`).toBe(400);
      expect(typeof (json(corrupt) as { error: unknown }).error, `${name}: the corrupt file is explained`).toBe("string");

      await writeFile(join(folder, otherFile), OTHER_FILE_TEXT);
      const saved = await fromPage("PUT", url, resource.valid);
      expect(saved.status, `${name}: valid PUT (replaces even a corrupt file)`).toBe(200);
      expect(await readText(folder, file), `${name}: file written`).toBe(resource.validFileText);
      expect(await readText(folder, otherFile), `${name}: the other file is not touched`).toBe(OTHER_FILE_TEXT);
      expect(await filesIn(folder), `${name}: no temp file left`).toEqual(["groups.json", "layout.json", "map.json"]);
      const readBack = json(await send("GET", url));
      expect(json(saved), `${name}: PUT answers the saved data`).toEqual(readBack);
      expect(readBack, `${name}: GET after PUT`).not.toEqual(resource.empty);

      for (const [label, body] of Object.entries(resource.invalid)) {
        const refused = await fromPage("PUT", url, body);
        expect(refused.status, `${name}: PUT with ${label}`).toBe(400);
        expect(typeof (json(refused) as { error: unknown }).error, `${name}: ${label} is explained`).toBe("string");
        expect(await readText(folder, file), `${name}: ${label} leaves the file as it was`).toBe(resource.validFileText);
      }

      const noHeader = { "Content-Type": "application/json" };
      const foreignOrigin = { "X-Flowmap": "1", Origin: "http://evil.example", "Content-Type": "application/json" };
      const changes: [string, object | undefined][] = [["PUT", resource.empty]];
      if (name === "layout") changes.push(["DELETE", undefined]);
      for (const [method, body] of changes) {
        for (const headers of [noHeader, foreignOrigin]) {
          const refused = await send(method, url, { headers, body: body && JSON.stringify(body) });
          expect(refused.status, `${name}: ${method} from outside the page`).toBe(403);
        }
      }
      expect(await readText(folder, file), `${name}: refused changes leave the file as it was`).toBe(resource.validFileText);

      if (name === "layout") {
        expect((await fromPage("DELETE", url)).status, "layout: DELETE").toBe(200);
        expect(await filesIn(folder), "layout: DELETE removes layout.json").toEqual(["groups.json", "map.json"]);
        expect((await fromPage("DELETE", url)).status, "layout: DELETE when there is no file").toBe(200);
        expect(await readText(folder, "groups.json"), "layout: DELETE does not touch groups.json").toBe(OTHER_FILE_TEXT);
      } else {
        expect((await fromPage("PUT", url, { groups: [] })).status, "groups: PUT of an empty list").toBe(200);
        expect(await filesIn(folder), "groups: an empty list removes groups.json").toEqual(["layout.json", "map.json"]);
        expect(json(await send("GET", url)), "groups: nothing left to read").toEqual({ groups: [] });
      }
    }
  });

  describe("live reload", () => {
    function connectToUpdates(): Promise<{ changes: () => number }> {
      return new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port: server.port, path: "/__flowmap-app/events" }, (response) => {
          streams.push(response);
          if (response.statusCode !== 200) return reject(new Error(`update stream answered ${response.statusCode}`));
          let received = "";
          response.on("data", (chunk: Buffer) => (received += chunk.toString()));
          resolve({ changes: () => (received.match(/^event: changed$/gm) ?? []).length });
        });
        request.on("error", reject);
      });
    }

    it("does not tell the page that saved a layout or groups change that the map changed, but still tells it about a write by someone else", async () => {
      const folder = await buildDemoMapFolder();
      await openFolder(folder);
      const updates = await connectToUpdates();

      const savedLayout = await fromPage("PUT", "/__flowmap/layout", { positions: { "a1-home": { x: 5, y: 6 } } });
      const savedGroups = await fromPage("PUT", "/__flowmap/groups", { groups: [{ id: "g1", name: "Pair", members: ["a1-home", "a2-detail"] }] });
      const deletedLayout = await fromPage("DELETE", "/__flowmap/layout");
      expect([savedLayout.status, savedGroups.status, deletedLayout.status]).toEqual([200, 200, 200]);
      await pause(8 * DEBOUNCE_MS);
      expect(updates.changes(), "own writes make no update").toBe(0);

      await writeFile(join(folder, "layout.json"), JSON.stringify({ positions: { "a2-detail": { x: 1, y: 1 } } }));

      expect(await until(() => updates.changes() >= 1), "a write by someone else makes an update").toBe(true);
    });

    it("tells the page that groups.json was changed by someone else with one update, while the page's own groups save still makes none", async () => {
      const folder = await buildDemoMapFolder();
      await openFolder(folder);
      const updates = await connectToUpdates();

      const saved = await fromPage("PUT", "/__flowmap/groups", { groups: [{ id: "g1", name: "Pair", members: ["a1-home", "a2-detail"] }] });
      expect(saved.status).toBe(200);
      await pause(8 * DEBOUNCE_MS);
      expect(updates.changes(), "own save makes no update").toBe(0);

      await writeFile(join(folder, "groups.json"), JSON.stringify({ version: 1, groups: [{ id: "g2", name: "Other", members: ["a3-list"] }] }));

      expect(await until(() => updates.changes() >= 1), "a groups.json written by someone else makes an update").toBe(true);
      await pause(8 * DEBOUNCE_MS);
      expect(updates.changes(), "exactly one").toBe(1);
    });
  });
});
