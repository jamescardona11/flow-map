import { execFile } from "node:child_process";

const USER_CANCELLED = "-128";

/** Opens the native macOS folder dialog. Resolves to the chosen POSIX path, or null if cancelled. */
export function chooseFolderWithDialog(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", "POSIX path of (choose folder with prompt \"Choose a map folder\")"],
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        if (stderr.includes(USER_CANCELLED)) return resolve(null);
        reject(error);
      },
    );
  });
}
