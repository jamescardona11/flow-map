import net from "node:net";

const TIMEOUT_MS = 3000;

/** The session could not take the message: its socket is missing, refuses connections or does not answer in time. */
export class SessionClosedError extends Error {}

/**
 * Writes the auth line and one user message to the session's Unix socket, then ends the connection.
 * The session never replies, so resolving means the connection was accepted and both lines were written.
 */
export function sendToSession(socketPath: string, token: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socketPath);
    const fail = () => {
      connection.destroy();
      reject(new SessionClosedError("session closed"));
    };
    connection.setTimeout(TIMEOUT_MS, fail);
    connection.on("error", fail);
    connection.on("connect", () => {
      const auth = JSON.stringify({ type: "auth", token });
      const message = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      connection.end(`${auth}\n${message}\n`, () => resolve());
    });
  });
}

const ALIVE_TIMEOUT_MS = 1000;

/** Whether the session's socket accepts a connection right now. It connects and closes without writing anything. */
export function isSessionAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socketPath);
    const finish = (alive: boolean) => {
      connection.destroy();
      resolve(alive);
    };
    connection.setTimeout(ALIVE_TIMEOUT_MS, () => finish(false));
    connection.on("error", () => finish(false));
    connection.on("connect", () => finish(true));
  });
}
