import { mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap, screenOf } from "./map-fixtures.ts";
import { createFixtures, linkTo, PNG, textClient, waitFor } from "./support.ts";

/** The most one image may weigh once decoded (5 MB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The smallest JPEG: start of image, a JFIF header, end of image. */
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

/** `bytes` padded with zeros to `size`: what follows the signature is not looked at, so it stands for a heavy photo. */
const padded = (bytes: Buffer, size: number) => Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);

const dataUrl = (type: "png" | "jpeg" | "gif", bytes: Buffer) => `data:image/${type};base64,${bytes.toString("base64")}`;

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
const fixtures = createFixtures();
const { startFakeSession, startFakeClaude, buildMapFolder } = fixtures;
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await fixtures.closeFakes();
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

const ask = (body: unknown) => fromPage("POST", "/__flowmap-app/request", body);

/** The text of the user message a fake session received (the second line, after the auth line). */
const contentOf = (raw: string) => (JSON.parse(raw.slice(0, -1).split("\n")[1]!) as { message: { content: string } }).message.content;

/** A map in its real path, linked to a fake session and open; `claudeBin` is the worker's command. */
async function openLinkedMap(options: { claudeBin?: string } = {}) {
  const dataDir = await fixtures.makeTempDir("flow-map-data-");
  server = await createServer({ port: 0, dataDir, ...options });
  const session = await startFakeSession();
  const map = checkoutMap({ screens: ["a1-home", "a2-detail"].map((id) => screenOf(id, { fingerprint: `fp-${id}` })) });
  const folder = await buildMapFolder(map, { real: true });
  await linkTo(dataDir, folder, session.socket);
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
  return { session, folder };
}

/** The absolute paths under `directory` that a message lists, in the order it lists them. */
const savedPaths = (message: string, directory: string) =>
  message.match(new RegExp(`${directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\`\\s]+`, "g")) ?? [];

describe("attaching images to a request", () => {
  it("saves each pasted image under temp/attachments with its real bytes and lists the paths after the request text, for the linked session and for the worker, without the bytes in the message", async () => {
    const fake = await startFakeClaude();
    const { session, folder } = await openLinkedMap({ claudeBin: fake.bin });
    const attachments = join(folder, "temp", "attachments");
    const heavy = [padded(PNG, MAX_IMAGE_BYTES), padded(JPEG, MAX_IMAGE_BYTES), padded(PNG, MAX_IMAGE_BYTES)];

    const toSession = await ask({
      text: "Match the mockup I pasted",
      images: [dataUrl("png", heavy[0]!), dataUrl("jpeg", heavy[1]!), dataUrl("png", heavy[2]!)],
    });
    const toWorker = await ask({ text: "Same, by worker", via: "worker", images: [dataUrl("png", PNG), dataUrl("jpeg", JPEG)] });

    expect(toSession.status).toBe(200);
    expect(toWorker.status).toBe(202);
    await waitFor(() => session.messages.length === 1, "the session to receive the message");
    await waitFor(async () => (await fake.calls()).length === 1, "the worker to start");
    const sent = [
      { message: contentOf(session.messages[0]!), text: "Match the mockup I pasted", bytes: heavy, extensions: [".png", ".jpg", ".png"] },
      { message: (await fake.calls())[0]!.argv[1]!, text: "Same, by worker", bytes: [PNG, JPEG], extensions: [".png", ".jpg"] },
    ];
    const everySavedFile: string[] = [];
    for (const { message, text, bytes, extensions } of sent) {
      const paths = savedPaths(message, attachments);
      expect(paths, `${text}: one path per image`).toHaveLength(bytes.length);
      expect(paths.map((path) => path.slice(path.lastIndexOf("."))), `${text}: extensions follow the image type`).toEqual(extensions);
      for (const [index, path] of paths.entries()) expect((await readFile(path)).equals(bytes[index]!), `${text}: image ${index + 1} is saved byte for byte`).toBe(true);
      everySavedFile.push(...paths);
      expect(message.indexOf(paths[0]!), `${text}: the paths come after the request text`).toBeGreaterThan(message.indexOf(text));
      expect(message, `${text}: tells Claude to open them with Read`).toMatch(/\bRead\b/);
      expect(message.length, `${text}: no image bytes in the message`).toBeLessThan(5_000);
    }
    expect(new Set(everySavedFile).size, "every image gets its own name").toBe(5);
    expect((await readdir(attachments)).sort(), "nothing else is left in the folder (no temp files)").toEqual(everySavedFile.map((path) => path.slice(attachments.length + 1)).sort());
  });

  it("answers 400 with an error, saving and delivering nothing, for images that are not a list of at most 3 PNG or JPEG data URLs of at most 5 MB whose bytes match their type, and when temp or temp/attachments is a symlink out of the folder", async () => {
    const fake = await startFakeClaude();
    const { session, folder } = await openLinkedMap({ claudeBin: fake.bin });
    const png = dataUrl("png", PNG);
    const outside = await fixtures.makeTempDir("flow-map-outside-", { real: true });
    const refused: Record<string, unknown> = {
      "images is not an array": "not a list",
      "images is an object": { first: png },
      "four images": [png, png, png, png],
      "an item that is not a string": [png, 42],
      "an item that is not a data URL": [png, "just text"],
      "a type that is not PNG or JPEG": [png, dataUrl("gif", Buffer.from("GIF89a"))],
      "a PNG type over JPEG bytes": [png, dataUrl("png", JPEG)],
      "a JPEG type over PNG bytes": [png, dataUrl("jpeg", PNG)],
      "a base64 that does not decode": [png, "data:image/png;base64,@@@@"],
      "an image of 5 MB and one byte": [png, dataUrl("png", padded(PNG, MAX_IMAGE_BYTES + 1))],
    };

    for (const [name, images] of Object.entries(refused)) {
      const reply = await ask({ text: "Look at this", images });
      expect(reply.status, name).toBe(400);
      expect(JSON.parse(reply.body), name).toEqual({ error: expect.any(String) });
    }
    const viaWorker = await ask({ text: "Look at this", via: "worker", images: [png, "just text"] });
    expect(viaWorker.status, "the worker route refuses the same way").toBe(400);

    expect(await readdir(folder), "a refused request writes nothing into the map folder").not.toContain("temp");

    await symlink(outside, join(folder, "temp"));
    const tempLinked = await ask({ text: "Look at this", images: [png] });
    expect(tempLinked.status, "temp is a symlink").toBe(400);
    expect(JSON.parse(tempLinked.body)).toEqual({ error: expect.any(String) });
    expect(await readdir(outside), "nothing written through the temp link").toEqual([]);

    await rm(join(folder, "temp"));
    await mkdir(join(folder, "temp"));
    await symlink(outside, join(folder, "temp", "attachments"));
    const attachmentsLinked = await ask({ text: "Look at this", images: [png] });
    expect(attachmentsLinked.status, "temp/attachments is a symlink").toBe(400);
    expect(JSON.parse(attachmentsLinked.body)).toEqual({ error: expect.any(String) });
    expect(await readdir(outside), "nothing written through the attachments link").toEqual([]);

    expect(session.connections(), "a refused request delivers nothing to the session").toBe(0);
    expect((await fake.calls()).length, "a refused request starts no worker").toBe(0);
  });
});
