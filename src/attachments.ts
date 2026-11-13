import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "./errors.ts";
import { isNotPlainFolder, writeFileAtomic } from "./fs-util.ts";
import { PNG_SIGNATURE } from "./png.ts";

/**
 * Images the designer pastes into the request box: each is saved in `<map>/temp/attachments/` and the request tells
 * Claude to open it with Read. The bytes never travel in the message.
 */

export const MAX_ATTACHED_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A character class and a length check, not a grouped pattern: that overflows the regex stack on megabytes.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const isBase64 = (text: string) => text.length % 4 === 0 && BASE64.test(text);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const IMAGE_TYPES = {
  png: { signature: PNG_SIGNATURE, extension: ".png" },
  jpeg: { signature: JPEG_SIGNATURE, extension: ".jpg" },
};

export type AttachedImage = { bytes: Buffer; extension: string };

/** The images of a request body, checked by their real signature; `undefined` (no images) gives an empty list. */
export function parseImages(value: unknown): AttachedImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequestError("images must be a list.");
  if (value.length > MAX_ATTACHED_IMAGES) throw new RequestError(`A request takes at most ${MAX_ATTACHED_IMAGES} images.`);
  return value.map((item, index) => {
    const label = `Image ${index + 1}`;
    const match = typeof item === "string" ? /^data:image\/(png|jpeg);base64,(.*)$/s.exec(item) : null;
    if (!match || !isBase64(match[2]!)) throw new RequestError(`${label} must be a PNG or JPEG data URL.`);
    const type = IMAGE_TYPES[match[1] as keyof typeof IMAGE_TYPES];
    const bytes = Buffer.from(match[2]!, "base64");
    if (!bytes.subarray(0, type.signature.length).equals(type.signature)) throw new RequestError(`${label} is not really a ${match[1]!.toUpperCase()}.`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new RequestError(`${label} is too big (the limit is 5 MB).`);
    return { bytes, extension: type.extension };
  });
}

/** Saves the images in `<map real path>/temp/attachments/` and answers their absolute paths; refuses when `temp` or `attachments` is a link. */
export async function saveImages(folder: string, images: AttachedImage[]): Promise<string[]> {
  const realFolder = await realpath(folder);
  const temp = join(realFolder, "temp");
  const directory = join(temp, "attachments");
  if ((await isNotPlainFolder(temp)) || (await isNotPlainFolder(directory))) {
    throw new RequestError("temp or temp/attachments is a symlink or a file, the app will not write there.");
  }
  await mkdir(directory, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const paths = images.map((image, index) => join(directory, `${stamp}-${index + 1}${image.extension}`));
  await Promise.all(images.map((image, index) => writeFileAtomic(paths[index]!, image.bytes)));
  return paths;
}

/** The block after the request text: where each image is, and that Claude opens them with Read. */
export function imagesBlock(paths: string[]): string {
  const list = paths.map((path) => `- \`${path}\``).join("\n");
  return `The designer attached ${paths.length === 1 ? "an image" : `${paths.length} images`}. Open each one with Read:\n${list}`;
}
