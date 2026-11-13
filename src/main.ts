import { defaultDataDir } from "./data-dir.ts";
import { createServer } from "./server.ts";

const server = await createServer({ port: Number(process.env.PORT ?? 9999), dataDir: defaultDataDir() });
process.stdout.write(`Flow Map listening on http://127.0.0.1:${server.port}\n`);
