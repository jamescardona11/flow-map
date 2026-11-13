import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataDir(): string {
  return process.env.FLOW_MAP_HOME ?? join(homedir(), ".flow-map");
}
