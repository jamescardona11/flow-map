import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { createFixtures, linkTo, textClient, TOKEN, unlink, waitFor } from "./support.ts";

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
let dataDir: string;
const fixtures = createFixtures();
const { startFakeSession, startFakeClaude, buildMapFolder } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await server?.close();
  server = undefined;
  await fixtures.closeFakes();
  await fixtures.removeTempDirs();
});

async function startApp(options: { requestWindowMs?: number; claudeBin?: string } = {}) {
  dataDir = await fixtures.makeTempDir("flow-map-data-");
  server = await createServer({ port: 0, dataDir, ...options });
}

/** A request the way the viewer page sends it: with the X-Flowmap header and its own origin. */
function ask(body: unknown, headers: Record<string, string> = {}) {
  return fromPage("POST", "/__flowmap-app/request", body, headers);
}

async function openLinkedMap(options: { requestWindowMs?: number; claudeBin?: string } = {}) {
  await startApp(options);
  const session = await startFakeSession();
  const folder = await buildMapFolder();
  await linkTo(dataDir, folder, session.socket);
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
  return { session, folder };
}

describe("sending a request to the linked session", () => {
  it("delivers the auth line and one user message with the request text, the map title and the selected screen id, and answers {sent: true}", async () => {
    const { session, folder } = await openLinkedMap();

    const withScreen = await ask({ text: "Make the header blue", screen: "a2-detail" });
    const withoutScreen = await ask({ text: "Rename the button" });

    expect(withScreen.status).toBe(200);
    expect(JSON.parse(withScreen.body)).toEqual({ sent: true });
    expect(JSON.parse(withoutScreen.body)).toEqual({ sent: true });
    await waitFor(() => session.messages.length === 2, "the session to receive both requests");
    const [first, second] = session.messages.map((raw) => {
      expect(raw.endsWith("\n"), "every line ends with a newline").toBe(true);
      const lines = raw.slice(0, -1).split("\n");
      expect(lines).toHaveLength(2);
      return { auth: lines[0], user: JSON.parse(lines[1]!) as { type: string; message: { role: string; content: string } } };
    });
    expect(first!.auth).toBe(`{"type":"auth","token":"${TOKEN}"}`);
    expect(first!.user.type).toBe("user");
    expect(first!.user.message.role).toBe("user");
    for (const part of ["Make the header blue", "Checkout flow", "a2-detail"]) expect(first!.user.message.content).toContain(part);
    expect(second!.auth).toBe(`{"type":"auth","token":"${TOKEN}"}`);
    expect(second!.user.message.content).toContain("Rename the button");
    expect(second!.user.message.content).toContain("Checkout flow");
    expect(second!.user.message.content).not.toContain("a2-detail");
    expect(await readdir(folder), "a request without images writes nothing into the map folder").not.toContain("temp");
  });

  it("refuses with a clear error and delivers nothing when the map is not linked (409), the session socket is missing (409), the text is blank (400) or the screen id is not in the map (400), and the error never contains the token", async () => {
    const fake = await startFakeClaude();
    const { session, folder } = await openLinkedMap({ claudeBin: fake.bin });
    const cases: { name: string; link: "none" | "missing" | "fake"; body: unknown; status: number }[] = [
      { name: "map not linked", link: "none", body: { text: "Hello" }, status: 409 },
      { name: "socket file missing", link: "missing", body: { text: "Hello" }, status: 409 },
      { name: "blank text", link: "fake", body: { text: "   " }, status: 400 },
      { name: "unknown screen", link: "fake", body: { text: "Hello", screen: "no-such-screen" }, status: 400 },
      { name: "worker: blank text", link: "fake", body: { text: "   ", via: "worker" }, status: 400 },
      { name: "worker: unknown screen", link: "fake", body: { text: "Hello", screen: "no-such-screen", via: "worker" }, status: 400 },
    ];

    for (const { name, link, body, status } of cases) {
      if (link === "none") await unlink(dataDir, folder);
      else await linkTo(dataDir, folder, link === "fake" ? session.socket : join(session.dir, "gone.sock"));

      const reply = await ask(body);

      expect(reply.status, name).toBe(status);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
      expect(reply.body, name).not.toContain(TOKEN);
      expect(reply.body, name).not.toContain(session.dir);
    }
    expect(session.connections()).toBe(0);
    expect(await fake.calls(), "no worker was started").toHaveLength(0);
  });

  it("refuses more than 5 accepted requests within the window with 429 and a Retry-After header, delivers nothing for the refused one, and accepts again after the window passes", async () => {
    const { session } = await openLinkedMap({ requestWindowMs: 1000 });

    const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => ask({ text: `Request ${n}` })));
    const refused = await ask({ text: "Request 6" });

    expect(burst.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect(JSON.parse(refused.body)).toEqual({ error: expect.any(String) });
    await waitFor(() => session.messages.length === 5, "the session to receive 5 messages");
    expect(session.connections()).toBe(5);

    await new Promise((done) => setTimeout(done, 1500));
    const later = await ask({ text: "Request 7" });

    expect(later.status).toBe(200);
    await waitFor(() => session.messages.length === 6, "the session to receive 6 messages");
    expect(session.messages[5]).toContain("Request 7");
  });

  it("refuses without the X-Flowmap header, from another origin or from a foreign Host with 403, and delivers nothing", async () => {
    const fake = await startFakeClaude();
    const { session } = await openLinkedMap({ claudeBin: fake.bin });
    const forgeries: Record<string, Record<string, string>> = {
      "without X-Flowmap": {},
      "from another origin": { "X-Flowmap": "1", Origin: "http://evil.example" },
      "from a foreign Host": { "X-Flowmap": "1", Host: "evil.example" },
    };

    for (const [how, headers] of Object.entries(forgeries)) {
      for (const via of [undefined, "worker"]) {
        const reply = await send("POST", "/__flowmap-app/request", {
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ text: "Evil request", via }),
        });
        expect(reply.status, `${how} (via ${via ?? "session"})`).toBe(403);
      }
    }

    expect(session.connections()).toBe(0);
    expect(await fake.calls(), "no worker was started").toHaveLength(0);
  });
});
