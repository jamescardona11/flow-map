import { mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { binaryClient, createFixtures } from "./support.ts";

const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

const HTML_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

type Reply = { status: number; body: Buffer; headers: http.IncomingHttpHeaders };
type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server;
const fixtures = createFixtures();
const { send } = binaryClient(() => server.port);

beforeEach(async () => {
  server = await createServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
  await fixtures.removeTempDirs();
});

function openFolder(path: string): Promise<Reply> {
  return send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** A temp dir in its real path (macOS temp dirs are symlinks, and the containment checks compare real paths). */
const makeRealTempDir = (prefix: string) => fixtures.makeTempDir(prefix, { real: true });

function mapWith(screens: Record<string, unknown>[]) {
  return {
    version: 1,
    title: "HTML screens",
    platform: "web",
    entry: "a1-home",
    flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: screens.map((screen) => ({
      title: screen.id,
      flow: "main",
      description: "",
      image: `screens/${screen.id}.png`,
      width: 1,
      height: 1,
      status: "ok",
      ...screen,
    })),
    edges: [],
    frontier: [],
  };
}

function embeddedData(html: string): { screens: Record<string, unknown>[] } {
  const match = html.match(/const DATA = (\{.*?\});/s);
  expect(match, "the page embeds `const DATA = {...};`").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("screens that carry an html mock", () => {
  it("refuses with a 400 naming the screen when its html is not a string, is absolute, has `..` segments or does not end in .html, and opens the map carrying the html field untouched when it is valid", async () => {
    const refused: { name: string; html: unknown }[] = [
      { name: "a number", html: 5 },
      { name: "null", html: null },
      { name: "an empty string", html: "" },
      { name: "an absolute path", html: "/etc/passwd.html" },
      { name: "a `..` segment", html: "screens-src/../map.json.html" },
      { name: "another extension", html: "screens-src/a2-detail.htm" },
      { name: "a name that only contains .html", html: "screens-src/a2-detail.html.png" },
    ];

    for (const { name, html } of refused) {
      const folder = await makeRealTempDir("flow-map-html-bad-");
      await writeFile(join(folder, "map.json"), JSON.stringify(mapWith([{ id: "a1-home" }, { id: "a2-detail", html }])));

      const failed = await openFolder(folder);
      const page = (await send("GET", "/")).body.toString();

      expect(failed.status, name).toBe(400);
      const { error } = JSON.parse(failed.body.toString()) as { error: string };
      expect(error, name).toContain("a2-detail");
      expect(error, name).toContain("html");
      expect(page, name).not.toContain("const DATA");
      expect(page, name).toContain('id="choose-folder"');
    }

    const folder = await makeRealTempDir("flow-map-html-ok-");
    await writeFile(
      join(folder, "map.json"),
      JSON.stringify(mapWith([{ id: "a1-home" }, { id: "a2-detail", html: "screens-src/a2-detail.html" }])),
    );

    const opened = await openFolder(folder);
    const screens = embeddedData((await send("GET", "/")).body.toString()).screens;

    expect(opened.status).toBe(200);
    expect(screens[1]!.html).toBe("screens-src/a2-detail.html");
    expect(screens[0]).not.toHaveProperty("html");
  });

  it("serves .html from screens-src/ and screens/ with the sandbox CSP headers, keeps serving other file types, and answers 404 for html elsewhere, for traversal and for symlinks that escape the folder", async () => {
    const root = await makeRealTempDir("flow-map-html-serve-");
    const folder = join(root, "map");
    for (const dir of ["screens-src", "screens", "history", "thumbs"]) await mkdir(join(folder, dir), { recursive: true });
    await mkdir(join(root, "outside-dir"));
    await writeFile(join(folder, "map.json"), JSON.stringify(mapWith([{ id: "a1-home" }])));
    await writeFile(join(folder, "screens-src", "a1-home.html"), "<h1>mock in screens-src</h1>");
    await writeFile(join(folder, "screens", "a2-detail.html"), "<h1>mock in screens</h1>");
    await writeFile(join(folder, "screens-src", "a1-home.png"), RED_PNG);
    await writeFile(join(folder, "history", "x.html"), "<h1>history html</h1>");
    await writeFile(join(folder, "thumbs", "x.html"), "<h1>thumbs html</h1>");
    await writeFile(join(root, "outside.html"), "OUTSIDE-HTML");
    await writeFile(join(root, "outside.png"), BLUE_PNG);
    await writeFile(join(root, "outside-dir", "secret.html"), "OUTSIDE-DIR-SECRET");
    await symlink(join(root, "outside.html"), join(folder, "screens-src", "link.html"));
    await symlink(join(root, "outside.png"), join(folder, "screens", "link.png"));
    await symlink(join(root, "outside-dir"), join(folder, "screens-src", "linkdir"));
    await openFolder(folder);

    const htmlHeaders = {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HTML_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    const served: { path: string; body: Buffer | string; contentType: string }[] = [
      { path: "/screens-src/a1-home.html", body: "<h1>mock in screens-src</h1>", contentType: "text/html; charset=utf-8" },
      { path: "/screens/a2-detail.html", body: "<h1>mock in screens</h1>", contentType: "text/html; charset=utf-8" },
      { path: "/screens-src/a1-home.png", body: RED_PNG, contentType: "image/png" },
    ];
    for (const { path, body, contentType } of served) {
      const reply = await send("GET", path);
      expect(reply.status, path).toBe(200);
      expect(reply.body.equals(Buffer.from(body)), path).toBe(true);
      expect(reply.headers["content-type"], path).toBe(contentType);
      if (contentType.startsWith("text/html")) {
        for (const [name, value] of Object.entries(htmlHeaders)) expect(reply.headers[name], `${path} ${name}`).toBe(value);
      }
    }

    const notServed = [
      "/history/x.html",
      "/thumbs/x.html",
      "/map.json",
      "/screens-src/../map.json",
      "/screens-src/%2e%2e/map.json",
      "/screens-src/%2e%2e/%2e%2e/outside.html",
      "/screens-src/link.html",
      "/screens/link.png",
      "/screens-src/linkdir/secret.html",
    ];
    for (const path of notServed) {
      const reply = await send("GET", path);
      expect(reply.status, path).toBe(404);
      for (const secret of ["history html", "thumbs html", "HTML screens", "OUTSIDE-HTML", "OUTSIDE-DIR-SECRET"]) {
        expect(reply.body.toString(), path).not.toContain(secret);
      }
      expect(reply.body.equals(BLUE_PNG), path).toBe(false);
    }
  });

  it("serves an .svg with the sandbox CSP and nosniff, so opening it directly cannot run its scripts on the app's origin", async () => {
    const folder = await makeRealTempDir("flow-map-svg-");
    await mkdir(join(folder, "screens"));
    await writeFile(join(folder, "map.json"), JSON.stringify(mapWith([{ id: "a1-home" }])));
    await writeFile(join(folder, "screens", "a1-home.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await openFolder(folder);

    const reply = await send("GET", "/screens/a1-home.svg");

    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("image/svg+xml");
    expect(reply.headers["content-security-policy"]).toContain("sandbox");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 404 for a symlink that leads to a file inside the map folder but outside the served folder", async () => {
    const folder = await makeRealTempDir("flow-map-link-inside-");
    await mkdir(join(folder, "screens"));
    await writeFile(join(folder, "map.json"), JSON.stringify(mapWith([{ id: "a1-home" }])));
    await writeFile(join(folder, "private.json"), JSON.stringify({ token: "FAKE-TOKEN-0000" }));
    await symlink(join(folder, "private.json"), join(folder, "screens", "a.png"));
    await openFolder(folder);

    const reply = await send("GET", "/screens/a.png");

    expect(reply.status).toBe(404);
    expect(reply.body.toString()).not.toContain("FAKE-TOKEN-0000");
  });
});
