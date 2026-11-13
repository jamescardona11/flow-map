import { crc32, deflateSync } from "node:zlib";
import { PNG_SIGNATURE } from "./png.ts";

const SIZE = 512;
const SAMPLES = 4;
const CORNER_RADIUS = 112;
const NODE_RADIUS = 48;
const LINE_HALF_WIDTH = 11;
const BACKGROUND = [20, 22, 26];
const ACCENT = [140, 196, 238];
/** The three nodes of the motif; the lines join the first to the second and the second to the third. */
const NODES = [
  { x: 124, y: 352 },
  { x: 256, y: 168 },
  { x: 388, y: 300 },
];

type Point = { x: number; y: number };

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const along = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy));
}

function insideRoundedSquare({ x, y }: Point): boolean {
  const cornerX = Math.max(CORNER_RADIUS - x, 0, x - (SIZE - CORNER_RADIUS));
  const cornerY = Math.max(CORNER_RADIUS - y, 0, y - (SIZE - CORNER_RADIUS));
  return Math.hypot(cornerX, cornerY) <= CORNER_RADIUS;
}

function onGraph(point: Point): boolean {
  const onNode = NODES.some((node) => Math.hypot(point.x - node.x, point.y - node.y) <= NODE_RADIUS);
  const onLine = [0, 1].some((index) => distanceToSegment(point, NODES[index]!, NODES[index + 1]!) <= LINE_HALF_WIDTH);
  return onNode || onLine;
}

/** The RGBA of one pixel, averaging SAMPLES x SAMPLES points so the edges are smooth. */
function pixel(column: number, row: number): number[] {
  const sum = [0, 0, 0];
  let covered = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const point = { x: column + (sx + 0.5) / SAMPLES, y: row + (sy + 0.5) / SAMPLES };
      if (!insideRoundedSquare(point)) continue;
      covered++;
      const color = onGraph(point) ? ACCENT : BACKGROUND;
      for (let channel = 0; channel < 3; channel++) sum[channel]! += color[channel]!;
    }
  }
  if (covered === 0) return [0, 0, 0, 0];
  return [...sum.map((value) => Math.round(value / covered)), Math.round((255 * covered) / (SAMPLES * SAMPLES))];
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

let cached: Buffer | undefined;

/** The app icon as a 512x512 RGBA PNG: a rounded dark square with a three-node graph. Always the same bytes. */
export function iconPng(): Buffer {
  if (cached) return cached;
  const rowLength = 1 + SIZE * 4;
  const raw = Buffer.alloc(rowLength * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      Buffer.from(pixel(column, row)).copy(raw, row * rowLength + 1 + column * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 6, 0, 0, 0], 8);
  cached = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return cached;
}
