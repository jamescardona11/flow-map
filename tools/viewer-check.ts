// Manual real-browser check of the viewer (not part of `npm test`: it needs Playwright and a Chromium).
// Usage:  PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tools/viewer-check.ts [scenario...]
//         LINKED=1 ... runs the run-flow scenarios with a map linked to a dead session.
// It starts the app against a fake `claude` (test/fake-claude.ts) and drives the page: ask without a session,
// a worker run surviving a reload, drafts surviving map changes, approvals, lost contact, the folder chooser.
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createServer as createSocketServer } from "node:net";
import { scratchFolderOf } from "../src/scratch-map.ts";
import { createServer } from "../src/server.ts";
import { writeSession } from "../src/session-link.ts";
import { createFakeClaude, type FakeClaudeInvocation } from "../test/fake-claude.ts";

// Only what this file uses of playwright-core, which is loaded at run time from PLAYWRIGHT_CORE.
interface Locator {
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  count(): Promise<number>;
  focus(): Promise<void>;
  first(): Locator;
}
interface Route {
  abort(): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string; postData(): string | null };
}
interface Page {
  goto(url: string): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  reload(): Promise<unknown>;
  close(): Promise<void>;
  title(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  hover(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>;
  setInputFiles(selector: string, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  locator(selector: string): Locator;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<A, T>(fn: (arg: A) => T, arg: A): Promise<T>;
  addInitScript(fn: () => void): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  route(url: string, handler: (route: Route) => void | Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as { chromium: { launch(): Promise<Browser> } };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const init = { type: "system", subtype: "init", session_id: SESSION_ID };
const result = (text: string, denials: object[] = []) => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: SESSION_ID, permission_denials: denials });
const denial = (command: string) => ({ tool_name: "Bash", tool_use_id: "toolu_x", tool_input: { command } });
const failedRun = { type: "result", subtype: "error_during_execution", is_error: true, result: "Claude could not finish", session_id: SESSION_ID };
const progress = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

async function world(invocations: FakeClaudeInvocation[]) {
  const root = await mkdtemp(join(tmpdir(), "fe-run-"));
  const folder = join(root, "map");
  await mkdir(join(folder, "screens"), { recursive: true });
  await writeFile(join(folder, "screens", "a1-home.png"), PNG);
  const writeMap = (title: string) => writeFile(join(folder, "map.json"), JSON.stringify({
    version: 1, title, platform: "web", entry: "a1-home", flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: [{ id: "a1-home", title: "a1-home", flow: "main", description: "", image: "screens/a1-home.png", width: 1, height: 1, status: "ok" }], edges: [], frontier: [] }));
  await writeMap("Run flow");
  if (process.env.LINKED) {
    await writeSession(join(root, "data"), folder, { socket: join(root, "dead.sock"), token: "FAKE" });  // a dead socket, in the data dir the server receives
  }
  const fake = await createFakeClaude({ mode: "stream", invocations });
  const server = await createServer({ port: 0, dataDir: join(root, "data"), claudeBin: fake.bin, workerTimeoutMs: 60_000, watchDebounceMs: 100 });
  const base = `http://127.0.0.1:${server.port}`;
  await fetch(base + "/__flowmap-app/open", { method: "POST", headers: { "X-Flowmap": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  return { base, page, fake, writeMap, folder, browser, async close() { await browser.close(); await fake.cleanup(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
const until = async (what: string, fn: () => Promise<boolean>, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error("timed out: " + what); };

type World = Awaited<ReturnType<typeof world>>;
// a second screen reached from the first by an edge, written before the page is opened
async function addSecondScreen(w: World) {
  const map = JSON.parse(await readFile(join(w.folder, "map.json"), "utf8"));
  map.screens.push({ ...map.screens[0], id: "a2-next", title: "Next", image: "screens/a1-home.png" });
  map.edges = [{ from: "a1-home", to: "a2-next", action: "tap", at: { x: 0, y: 0, w: 1, h: 1 } }];
  await writeFile(join(w.folder, "map.json"), JSON.stringify(map));
  await new Promise((r) => setTimeout(r, 500));
}
const sendRun =async (w: World, text: string) => {
  await w.page.fill("#askText", text);
  if (process.env.LINKED) { await until("worker button", () => w.page.locator("#askWorker").isVisible()); await w.page.click("#askWorker"); }
  else await w.page.click("#askSend");
};
const tab = (name: string) => `#ask >> role=tab[name="${name}"]`;
// "shown" | "hidden" | "missing" for each selector; a checkbox counts as its label, which is the clickable area
const visibility = (page: Page, selectors: string[]) => page.evaluate((sels: string[]) => Object.fromEntries(sels.map((sel) => {
  const el = document.querySelector(sel);
  if (!el) return [sel, "missing"];
  const target = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.closest("label") ?? el) : el;
  const box = target.getBoundingClientRect();
  const hasBox = box.width > 0 && box.height > 0 || sel === "#askMsg"; // an empty status line has no size
  return [sel, target.checkVisibility({ visibilityProperty: true }) && hasBox ? "shown" : "hidden"];
})), selectors) as Promise<Record<string, string>>;
// records each write to the status line with whether the card was on screen when it happened: a change in a hidden node is not announced
const spyOnRunMsg = (page: Page) => page.evaluate(() => {
  const msg = document.getElementById("runMsg")!, card = document.getElementById("runCard")!;
  const writes: { text: string; visible: boolean }[] = [];
  const own = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  Object.defineProperty(msg, "textContent", { get() { return own.get!.call(msg); }, set(text: string) { writes.push({ text, visible: card.checkVisibility() }); own.set!.call(msg, text); } });
  (window as unknown as { runMsgWrites: typeof writes }).runMsgWrites = writes;
});
const rgb = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
// a map with no screens, served on its own: the scratch map the server creates and opens on its first `GET /`
async function emptyWorld() {
  const root = await mkdtemp(join(tmpdir(), "fe-empty-"));
  const dataDir = join(root, "data");
  const folder = scratchFolderOf(dataDir);
  const fake = await createFakeClaude({ mode: "stream", invocations: [{ before: [init] }] });
  const server = await createServer({ port: 0, dataDir, claudeBin: fake.bin, watchDebounceMs: 100 });
  const base = `http://127.0.0.1:${server.port}`;
  await fetch(base + "/");  // creates the scratch map
  const browser = await chromium.launch();
  const page = await browser.newPage();
  return { base, page, folder, async close() { await browser.close(); await fake.cleanup(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
const scenarios: Record<string, () => Promise<string>> = {
  // SP1: a map that was never linked can still ask Claude (the app's own worker)
  async unlinkedCanAsk() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box visible without a linked session", () => w.page.locator("#ask").isVisible());
      await w.page.fill("#askText", "Make it blue");
      await w.page.click("#askSend");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.fake.release();
      await until("result shown", async () => (await w.page.textContent("#askMsg")) === "All done");
      return "ok";
    } finally { await w.close(); }
  },
  // FE1: a reload in the middle of a run keeps following it, and the approval box comes back
  async reloadKeepsRun() {
    const w = await world([{ before: [init, result("Blocked", [denial("npm test")])] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Run the tests");
      await until("approval box", () => w.page.locator("#runApproval").isVisible());
      await w.writeMap("Changed by Claude"); // the watcher tells the page to reload
      await until("page reloaded", async () => (await w.page.title()).includes("Changed by Claude") || (await w.page.textContent("body"))!.includes("Changed by Claude"), 10000);
      await until("approval box again after the reload", () => w.page.locator("#runApproval").isVisible(), 10000);
      return "ok";
    } finally { await w.close(); }
  },
  // FE3: what was typed while a run went on survives the end of the run
  async typingSurvivesRun() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "first request");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.page.evaluate(() => { (document.getElementById("askText") as HTMLTextAreaElement).value = "the next request"; }); // the dock is hidden while a run goes on, so the box cannot be typed into
      await w.fake.release();
      await until("run finished", async () => (await w.page.textContent("#askMsg")) === "All done");
      const kept = await w.page.inputValue("#askText");
      if (kept !== "the next request") throw new Error(`typed text was lost: "${kept}"`);
      return "ok";
    } finally { await w.close(); }
  },
  // A run that is going on can be cancelled from the page, which shows the outcome and frees the box
  async cancelRun() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      if (await w.page.locator("#runCancel").isVisible()) throw new Error("Cancel is visible before any run");
      await sendRun(w, "a long request");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await until("Cancel button while running", () => w.page.locator("#runCancel").isVisible());
      await w.page.click("#runCancel");
      await until("cancelled outcome", async () => ((await w.page.textContent("#askMsg")) ?? "").includes("Cancelled by the designer."));
      await until("Cancel button hidden afterwards", async () => !(await w.page.locator("#runCancel").isVisible()));
      return "ok";
    } finally { await w.close(); }
  },
  // «Capture it now» asks Claude (the app's own worker when no session is open) to capture a new screen
  async captureNow() {
    const w = await world([{ before: [init], hold: true, after: [result("Captured")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await w.page.click(tab("New screen"));
      await until("capture button visible", () => w.page.locator("#nsCapture").isVisible());
      await w.page.fill("#nsTitle", "Order summary");
      await w.page.fill("#nsDescription", "https://example.test/summary");
      await w.page.click("#nsCapture");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.fake.release();
      await until("result shown", async () => (await w.page.textContent("#askMsg")) === "Captured");
      return "ok";
    } finally { await w.close(); }
  },
  // redesign 1: the header is one slim row and the map keeps the rest of the window
  async slimBarCanvasFirst() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const layout = await w.page.evaluate(() => {
        const header = document.querySelector("header")!;
        const inBar = ["chooseMap", "title", "legend", "q", "flowsBtn", "zout", "zlabel", "zin", "zfit", "changesBtn", "navBtn"];
        const notInBar = ["ask", "newScreen", "designContract", "runEvents", "runApproval"];
        const view = document.getElementById("view")!.getBoundingClientRect();
        return {
          barHeight: header.getBoundingClientRect().height,
          missingFromBar: inBar.filter((id) => !header.contains(document.getElementById(id))),
          strayInBar: notInBar.filter((id) => header.contains(document.getElementById(id))),
          viewTop: view.top, viewBottom: view.bottom, viewHeight: view.height, windowHeight: innerHeight,
        };
      });
      if (layout.barHeight > 56) throw new Error(`the header is ${layout.barHeight}px tall, at most 56 allowed`);
      if (layout.missingFromBar.length) throw new Error(`not in the header: ${layout.missingFromBar.join(", ")}`);
      if (layout.strayInBar.length) throw new Error(`still in the header: ${layout.strayInBar.join(", ")}`);
      if (layout.viewTop > 56) throw new Error(`the map starts ${layout.viewTop}px from the top, at most 56 allowed`);
      if (Math.abs(layout.viewBottom - layout.windowHeight) > 1) throw new Error(`the map ends at ${layout.viewBottom}px, not at the bottom of the window (${layout.windowHeight}px)`);
      if (layout.viewHeight < 840) throw new Error(`the map is ${layout.viewHeight}px tall, at least 840 needed`);
      return "ok";
    } finally { await w.close(); }
  },
  // redesign 1: one dock at the bottom with three tabs; each tab shows only its own controls; Capture now posts like the old button
  async dockTabs() {
    const w = await world([{ before: [init], hold: true, after: [result("Captured")] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const dock = () => w.page.evaluate(() => {
        const ask = document.getElementById("ask")!;
        const box = ask.getBoundingClientRect();
        const nav = document.getElementById("nav")!;
        const drawerLeft = nav.hidden ? innerWidth : nav.getBoundingClientRect().left;
        return {
          position: getComputedStyle(ask).position, width: box.width, centre: box.left + box.width / 2, bottom: box.bottom,
          areaCentre: drawerLeft / 2, windowHeight: innerHeight,
          tabs: Array.from(ask.querySelectorAll('[role="tablist"] [role="tab"]')).map((t) => ({ name: t.textContent!.trim(), tag: t.tagName, selected: t.getAttribute("aria-selected") })),
          oldDisclosure: document.querySelector("details#newScreen, #newScreen > summary") !== null,
          attachLabel: (() => { const label = document.getElementById("askAttach")?.closest("label")?.getBoundingClientRect(); return label ? { width: label.width, height: label.height } : null; })(),
        };
      });
      const checkDock = (d: Awaited<ReturnType<typeof dock>>, where: string) => {
        if (!["fixed", "absolute"].includes(d.position)) throw new Error(`the dock is position:${d.position}, not fixed or absolute`);
        if (d.width > 800) throw new Error(`the dock is ${d.width}px wide, at most 800 allowed`);
        if (Math.abs(d.centre - d.areaCentre) > 24) throw new Error(`the dock is centred at ${d.centre}px, the area ${where} is centred at ${d.areaCentre}px`);
        if (d.windowHeight - d.bottom < 0 || d.windowHeight - d.bottom > 48) throw new Error(`the dock ends ${d.windowHeight - d.bottom}px from the bottom of the window, expected 0 to 48`);
      };
      const first = await dock();
      checkDock(first, "of the window");
      if (first.tabs.map((t) => t.name).join("|") !== "Change the map|New screen|Capture now") throw new Error(`tabs are: ${JSON.stringify(first.tabs)}`);
      if (first.tabs.some((t) => t.tag !== "BUTTON")) throw new Error("the tabs are not buttons");
      if (first.tabs.filter((t) => t.selected === "true").map((t) => t.name).join() !== "Change the map") throw new Error(`with screens the selected tab must be "Change the map": ${JSON.stringify(first.tabs)}`);
      if (first.oldDisclosure) throw new Error("the old <details id=newScreen> disclosure is still there");
      if (!first.attachLabel || first.attachLabel.width < 24 || first.attachLabel.height < 24) throw new Error(`the attach-comments label is ${JSON.stringify(first.attachLabel)}, at least 24x24 needed`);

      await w.page.evaluate(() => { location.hash = "#/s/a1-home"; });
      await until("drawer open", () => w.page.locator("#nav").isVisible());
      checkDock(await dock(), "left of the open drawer");

      const panes: Record<string, string[]> = {
        "Change the map": ["#askText", "#askSend", "#askAttach", "#askMsg"],
        "New screen": ["#nsTitle", "#nsDescription", "#nsAction", "#nsFromLabel", "#nsFrom", "#nsSend", "#nsCapture"],
        "Capture now": ["#capTitle", "#capNote", "#capSend"],
      };
      for (const name of Object.keys(panes)) {
        await w.page.click(tab(name));
        const seen = await visibility(w.page, Object.values(panes).flat());
        for (const [pane, controls] of Object.entries(panes)) {
          for (const sel of controls) {
            const want = pane === name ? "shown" : "hidden";
            if (seen[sel] === "missing") throw new Error(`${sel} does not exist`);
            if (seen[sel] !== want) throw new Error(`on the "${name}" tab ${sel} is ${seen[sel]}, expected ${want}`);
          }
        }
      }

      // Capture now: same route and body as the "Capture it now" button of the New screen pane
      const placeholder = (await w.page.getAttribute("#capNote", "placeholder")) ?? "";
      if (!/URL/.test(placeholder) || !/iOS simulator/.test(placeholder)) throw new Error(`the note placeholder does not say where the app is: "${placeholder}"`);
      if (((await w.page.textContent("#capSend")) ?? "").trim() !== "Capture it now") throw new Error("the submit button is not labelled \"Capture it now\"");
      const posted: { url?: string; body?: unknown } = {};
      await w.page.route("**/__flowmap-app/capture", async (route: Route) => { posted.body = JSON.parse(route.request().postData() ?? "null"); await route.continue(); });
      await w.page.fill("#capTitle", "Order summary");
      await w.page.fill("#capNote", "https://example.test/summary");
      await w.page.click("#capSend");
      await until("capture posted", async () => posted.body !== undefined);
      const body = posted.body as { title?: string; note?: string };
      if (body.title !== "Order summary" || body.note !== "https://example.test/summary") throw new Error(`the capture body is ${JSON.stringify(body)}`);
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.fake.release();
      await until("result shown", async () => (await w.page.textContent("#askMsg")) === "Captured");
      return "ok";
    } finally { await w.close(); }
  },
  // redesign 1: a run takes the dock's place with its own card; the session chip says in plain words how Claude is reached
  async runCardAndSessionChip() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    const socketPath = join(dirname(w.folder), "alive.sock");
    const live = createSocketServer();
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      const chip = async () => ({ text: ((await w.page.textContent("#askState")) ?? "").trim(), colour: rgb(await w.page.evaluate(() => getComputedStyle(document.getElementById("askState")!).color)) });
      const reloadUntilChip = async (text: string) => { await w.page.reload(); await until(`chip "${text}"`, async () => (await chip()).text === text); return chip(); };

      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await until("chip", async () => (await chip()).text !== "");
      const unlinked = await chip();
      if (unlinked.text !== "Runs on its own") throw new Error(`unlinked chip reads "${unlinked.text}"`);
      if (Math.max(...unlinked.colour) - Math.min(...unlinked.colour) > 30) throw new Error(`the unlinked chip is not grey: rgb(${unlinked.colour})`);

      // the "?" button toggles the help as a popover
      if ((await w.page.textContent("#askHelpBtn"))?.trim() !== "?") throw new Error("the help button does not read \"?\"");
      if ((await w.page.getAttribute("#askHelpBtn", "aria-label")) !== "How to link a Claude session") throw new Error("the help button has no aria-label \"How to link a Claude session\"");
      if (await w.page.locator("#askHelp").isVisible()) throw new Error("the help is open before it is asked for");
      await w.page.click("#askHelpBtn");
      await until("help open", () => w.page.locator("#askHelp").isVisible());
      const helpPosition = await w.page.evaluate(() => getComputedStyle(document.getElementById("askHelp")!).position);
      if (!["fixed", "absolute"].includes(helpPosition)) throw new Error(`the help is position:${helpPosition}, not a popover`);
      await w.page.click("#askHelpBtn");
      await until("help closed", async () => !(await w.page.locator("#askHelp").isVisible()));

      // a run replaces the dock with the run card, which wraps the approval box and the cancel button
      await sendRun(w, "a long request");
      await until("run card", () => w.page.locator("#runCard").isVisible());
      await until("Cancel button while running", () => w.page.locator("#runCancel").isVisible());
      if (await w.page.locator("#ask").isVisible()) throw new Error("the dock is visible while a run is active");
      const owned = await w.page.evaluate(() => { const card = document.getElementById("runCard")!; return ["runEvents", "runApproval", "runCancel"].filter((id) => !card.contains(document.getElementById(id))); });
      if (owned.length) throw new Error(`not inside #runCard: ${owned.join(", ")}`);
      const cardBottom = await w.page.evaluate(() => innerHeight - document.getElementById("runCard")!.getBoundingClientRect().bottom);
      if (cardBottom < 0 || cardBottom > 48) throw new Error(`the run card ends ${cardBottom}px from the bottom of the window, expected 0 to 48`);
      await w.page.click("#runCancel");
      await until("run card hidden", async () => !(await w.page.locator("#runCard").isVisible()));
      await until("dock back", () => w.page.locator("#ask").isVisible());

      // linked and alive: green; linked but its socket is gone: amber
      await new Promise<void>((done) => live.listen(socketPath, done));
      await writeSession(join(dirname(w.folder), "data"), w.folder, { socket: socketPath, token: "FAKE" });
      const linked = await reloadUntilChip("Session linked");
      if (!(linked.colour[1] > linked.colour[0] + 40 && linked.colour[1] > linked.colour[2] + 20)) throw new Error(`the linked chip is not green: rgb(${linked.colour})`);
      await new Promise<void>((done) => live.close(() => done()));
      const gone = await reloadUntilChip("Session gone");
      if (!(gone.colour[0] > gone.colour[2] + 100 && gone.colour[0] > gone.colour[1] + 30)) throw new Error(`the gone chip is not amber: rgb(${gone.colour})`);
      return "ok";
    } finally { live.close(); await w.fake.release().catch(() => undefined); await w.close(); }
  },
  // A pasted image shows as a thumbnail that can be removed; other pastes are left alone
  async pasteImage() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const paste = (type: string) => w.page.evaluate(([mime, b64]: [string, string]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], "pasted", { type: mime }));
        const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
        document.getElementById("askText")!.dispatchEvent(event);
        return event.defaultPrevented;
      }, [type, PNG.toString("base64")] as [string, string]);
      if (!(await paste("image/png"))) throw new Error("a pasted PNG was not taken");
      if (await paste("image/gif")) throw new Error("a pasted GIF must be left alone");
      await until("one thumbnail", async () => (await w.page.locator("#askImages .thumb").count()) === 1);
      await w.page.click("#askImages .thumb button");
      await until("thumbnail removed", async () => (await w.page.locator("#askImages .thumb").count()) === 0);
      await paste("image/png");
      await sendRun(w, "look at this");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.fake.release();
      await until("result and strip emptied", async () => (await w.page.textContent("#askMsg")) === "All done" && (await w.page.locator("#askImages .thumb").count()) === 0);
      return "ok";
    } finally { await w.close(); }
  },
  // FE7: when the app stops answering, the page says so instead of showing "Running…" forever
  async lostContact() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "go");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.page.route("**/__flowmap-app/runs/**", (route: Route) => route.abort());
      await until("lost-contact message", async () => /lost contact/i.test((await w.page.textContent("#askMsg")) ?? ""), 15000);
      return "ok";
    } finally { await w.close(); }
  },
  // FE2: a map change while the designer has a draft does not reload the page; a banner offers it instead
  async draftSurvivesChange() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await w.page.fill("#askText", "my unsent draft");
      await w.writeMap("Changed by Claude");
      await until("banner", () => w.page.locator("#mapChanged").isVisible(), 8000);
      if ((await w.page.inputValue("#askText")) !== "my unsent draft") throw new Error("the draft was lost");
      await w.page.click("#mapChangedReload");
      await until("page reloaded", async () => (await w.page.textContent("body"))!.includes("Changed by Claude"), 8000);
      return "ok";
    } finally { await w.close(); }
  },
  // FE2 (regression): without a draft the page still reloads by itself
  async noDraftReloads() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await w.writeMap("Changed by Claude");
      await until("page reloaded", async () => (await w.page.textContent("body"))!.includes("Changed by Claude"), 8000);
      return "ok";
    } finally { await w.close(); }
  },
  // FE8: the screen open in the detail stays highlighted on the map after a load
  async highlightAfterLoad() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/#/s/a1-home");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      await new Promise((r) => setTimeout(r, 2000));
      const n = await w.page.locator(".node.cur").count();
      if (n !== 1) throw new Error(`expected one highlighted node, found ${n}`);
      return "ok";
    } finally { await w.close(); }
  },
  // FE4: Re-capture names its target and is off when no screen is open
  async recaptureNamesTarget() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      if (!(await w.page.locator("#rcSend").isDisabled())) throw new Error("Re-capture is enabled with no screen open");
      await w.page.evaluate(() => { location.hash = "#/s/a1-home"; });
      await until("button names the screen", async () => /a1-home/.test((await w.page.textContent("#rcSend")) ?? ""));
      if (await w.page.locator("#rcSend").isDisabled()) throw new Error("Re-capture is disabled with a screen open");
      await w.page.click("#toMap");
      await until("disabled again after closing the detail", () => w.page.locator("#rcSend").isDisabled());
      return "ok";
    } finally { await w.close(); }
  },
  // the Send button waits while the app's own Claude runs
  async sendDisabledWhileRunning() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "go");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      if (!(await w.page.locator("#askSend").isDisabled())) throw new Error("Send is enabled during a run");
      await w.fake.release();
      await until("Send enabled again", async () => !(await w.page.locator("#askSend").isDisabled()));
      return "ok";
    } finally { await w.close(); }
  },
  // FE5: the chooser labels its input, announces errors and reports a failing request
  async chooserErrors() {
    const root = await mkdtemp(join(tmpdir(), "fe-choose-"));
    const server = await createServer({ port: 0, dataDir: root });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/choose`);
      if (!(await page.getAttribute("#typed-path", "aria-label"))) throw new Error("input has no aria-label");
      if ((await page.getAttribute("#open-error", "role")) !== "alert") throw new Error("error has no role=alert");
      await page.route("**/__flowmap-app/open", (route: Route) => route.abort());
      await page.fill("#typed-path", "/nowhere");
      await page.keyboard.press("Enter");
      await until("error shown", async () => ((await page.textContent("#open-error")) ?? "").length > 0, 5000);
      return "ok";
    } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  },
  // The chooser looks like the viewer: dark tokens, 32 px controls, cards for the working map and the recents, visible focus, readable text
  async chooserLook() {
    const root = await mkdtemp(join(tmpdir(), "fe-chooselook-"));
    const dataDir = join(root, "data");
    const recent = join(root, "recent-map");
    await mkdir(join(recent, "screens"), { recursive: true });
    await writeFile(join(recent, "screens", "a1-home.png"), PNG);
    await writeFile(join(recent, "map.json"), JSON.stringify({
      version: 1, title: "Recent map", platform: "web", entry: "a1-home", flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
      screens: [{ id: "a1-home", title: "a1-home", flow: "main", description: "", image: "screens/a1-home.png", width: 1, height: 1, status: "ok" }], edges: [], frontier: [] }));
    const server = await createServer({ port: 0, dataDir });
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(base + "/");  // creates the scratch map
    await fetch(base + "/__flowmap-app/open", { method: "POST", headers: { "X-Flowmap": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path: recent }) });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(base + "/choose");
      const problems: string[] = [];
      const expectEqual = (what: string, actual: unknown, expected: unknown) => { if (actual !== expected) problems.push(`${what} is ${actual}, expected ${expected}`); };
      const styles = (selector: string) => page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const css = getComputedStyle(el);
        return { height: el.getBoundingClientRect().height, background: css.backgroundColor, color: css.color, border: css.borderTopColor, borderWidth: css.borderTopWidth, radius: css.borderTopLeftRadius };
      }, selector);

      const body = await styles("body");
      expectEqual("the page background", body?.background, "rgb(11, 13, 16)");
      expectEqual("the text colour", body?.color, "rgb(238, 241, 244)");
      expectEqual("the heading", (await page.textContent("h1"))?.trim(), "Open a map");

      for (const [name, selector] of [["Choose folder…", "#choose-dialog"], ["the path input", "#typed-path"], ["Open", "#choose-folder button[type=submit]"]] as const) {
        const control = await styles(selector);
        if (!control) { problems.push(`${name} is missing`); continue; }
        if (Math.abs(control.height - 32) > 0.5) problems.push(`${name} is ${control.height}px tall, expected 32`);
        expectEqual(`the radius of ${name}`, control.radius, "8px");
        if (selector.includes("submit")) {
          expectEqual("the background of Open", control.background, "rgb(140, 196, 238)");
          expectEqual("the text colour of Open", control.color, "rgb(6, 18, 28)");
        } else if (selector === "#choose-dialog") {
          expectEqual("the background of Choose folder…", control.background, "rgb(24, 30, 37)");
          expectEqual("the border of Choose folder…", control.border, "rgb(51, 61, 73)");
        } else expectEqual("the border of the path input", control.border, "rgb(51, 61, 73)");
      }

      const cards = await page.evaluate(() => Array.from(document.querySelectorAll("button[data-path]")).map((card, index) => {
        const css = getComputedStyle(card);
        const inside = (text: string) => Array.from(card.querySelectorAll("*")).find((el) => el.children.length === 0 && el.textContent?.trim() === text);
        const title = inside(index === 0 ? "Untitled" : "Recent map");
        const path = inside((card as HTMLElement).dataset.path ?? "");
        return {
          label: card.textContent ?? "", height: card.getBoundingClientRect().height, background: css.backgroundColor, border: css.borderTopColor, radius: css.borderTopLeftRadius,
          titleColor: title ? getComputedStyle(title).color : "missing", pathColor: path ? getComputedStyle(path).color : "missing", pathFont: path ? getComputedStyle(path).fontFamily : "missing",
        };
      }));
      expectEqual("the number of cards (working map + one recent)", cards.length, 2);
      if (cards[0] && !cards[0].label.includes("Working map")) problems.push(`the first card is not the Working map: "${cards[0].label}"`);
      for (const card of cards) {
        if (card.height < 56) problems.push(`a card is ${card.height}px tall, expected at least 56`);
        expectEqual("the card background", card.background, "rgb(18, 22, 27)");
        expectEqual("the card border", card.border, "rgb(37, 44, 53)");
        expectEqual("the card radius", card.radius, "12px");
        expectEqual("the card title colour", card.titleColor, "rgb(238, 241, 244)");
        expectEqual("the card path colour", card.pathColor, "rgb(154, 165, 177)");
        if (!/mono|menlo|courier/i.test(card.pathFont)) problems.push(`the card path font is ${card.pathFont}, expected a monospace`);
      }
      if (cards.length) {
        await page.hover("button[data-path]");
        await new Promise((r) => setTimeout(r, 300));
        expectEqual("the border of a hovered card", (await styles("button[data-path]"))?.border, "rgb(140, 196, 238)");
      }

      // Tab through every control: each one shows a 2 px accent outline
      const focusable = await page.evaluate(() => document.querySelectorAll("button, input, a[href]").length);
      for (let i = 0; i < focusable; i++) {
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const css = getComputedStyle(el);
          return { what: el.id || el.className || el.tagName, style: css.outlineStyle, width: css.outlineWidth, color: css.outlineColor };
        });
        if (ring.style === "none" || ring.width !== "2px" || ring.color !== "rgb(140, 196, 238)") problems.push(`focus ring of ${ring.what} is ${ring.style} ${ring.width} ${ring.color}, expected 2px accent`);
      }

      const lowContrast = await page.evaluate(() => {
        const parse = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = ([r, g, b]: number[]) => [r, g, b].map((v) => { const c = v! / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
        const backgroundOf = (el: Element): number[] => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const [r, g, b, a = 1] = parse(getComputedStyle(node).backgroundColor);
            if (a > 0) return [r!, g!, b!];
          }
          return [255, 255, 255];
        };
        const found: string[] = [];
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          if (["SCRIPT", "STYLE"].includes(el.tagName)) continue;
          const text = Array.from(el.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent?.trim()).join("");
          if (!text) continue;
          const fg = luminance(parse(getComputedStyle(el).color));
          const bg = luminance(backgroundOf(el));
          const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          if (ratio < 4.5) found.push(`"${text.slice(0, 30)}" ${ratio.toFixed(2)}:1`);
        }
        return found;
      });
      if (lowContrast.length) problems.push(`text below 4.5:1: ${lowContrast.join(", ")}`);

      if (problems.length) throw new Error(problems.join("; "));
      return "ok";
    } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  },
  // FE1 (review 2): after giving up, the approval box is gone too
  async approvalHiddenOnLostContact() {
    const w = await world([{ before: [init, result("Blocked", [denial("npm test")])] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Run the tests");
      await until("approval box", () => w.page.locator("#runApproval").isVisible());
      await w.page.route("**/__flowmap-app/runs/**", (route: Route) => route.abort());
      await until("lost contact", async () => /lost contact/i.test((await w.page.textContent("#askMsg")) ?? ""), 15000);
      if (await w.page.locator("#runApproval").isVisible()) throw new Error("approval box still visible after giving up");
      return "ok";
    } finally { await w.close(); }
  },
  // FE2 (review 2): a failed re-capture click does not make the followed request's text a draft
  async failedRecaptureKeepsSent() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Make it blue");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.page.evaluate(() => { location.hash = "#/s/a1-home"; });
      await until("re-capture enabled", async () => !(await w.page.locator("#rcSend").isDisabled()));
      await w.page.evaluate(() => (document.getElementById("rcSend") as HTMLButtonElement).click()); // 409: a run is already in progress
      await until("busy message", async () => /already in progress/i.test((await w.page.textContent("#askMsg")) ?? ""));
      await w.writeMap("Changed by Claude");
      await until("page reloaded by itself", async () => (await w.page.textContent("body"))!.includes("Changed by Claude"), 8000);
      if (await w.page.locator("#mapChanged").isVisible().catch(() => false)) throw new Error("banner shown instead of reloading");
      return "ok";
    } finally { await w.close(); }
  },
  // FE3 (review 2): an open group form with a name typed is a draft
  async groupNameIsDraft() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await w.page.evaluate(() => { const f = document.getElementById("groupForm") as HTMLElement; f.hidden = false; (document.getElementById("groupName") as HTMLInputElement).value = "My group"; });
      await w.writeMap("Changed by Claude");
      await until("banner", () => w.page.locator("#mapChanged").isVisible(), 8000);
      return "ok";
    } finally { await w.close(); }
  },
  // FE5 (review 2): a run that ended before the reloaded page re-attached still shows its result
  async resultAfterReload() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "go");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.page.route("**/__flowmap-app/runs/**", (route: Route) => route.abort()); // the page cannot see the end
      await w.fake.release();
      await until("run over on the server", async () => (await fetch(w.base + "/__flowmap-app/runs/current")).status === 404, 10000);
      await w.page.unroute("**/__flowmap-app/runs/**");
      await w.page.reload();
      await until("result shown after the reload", async () => (await w.page.textContent("#askMsg")) === "All done", 8000);
      return "ok";
    } finally { await w.close(); }
  },
  // polling never has two requests for the same run in flight, even when the app answers slowly
  async pollNeverOverlaps() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "go");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      let inFlight = 0, most = 0;
      await w.page.route("**/__flowmap-app/runs/*", async (route: Route) => {
        inFlight++; most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 3500));
        inFlight--; await route.continue();
      });
      await new Promise((r) => setTimeout(r, 9000));
      if (most > 1) throw new Error(`${most} polls were in flight at once`);
      await w.page.unroute("**/__flowmap-app/runs/*");
      return "ok";
    } finally { await w.close(); }
  },
  // a screen can be picked for a group from the keyboard: Space toggles, and the state is announced
  async keyboardPicksScreens() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      await until("annotations loaded", async () => (await w.page.evaluate(() => document.body.innerText.length)) > 0);
      await new Promise((r) => setTimeout(r, 1500));
      await w.page.locator(".node").first().focus();
      await w.page.keyboard.press("Space");
      await until("picked", async () => (await w.page.locator(".node.picked").count()) === 1, 4000);
      if ((await w.page.locator('.node[aria-pressed="true"]').count()) !== 1) throw new Error("picked node is not aria-pressed");
      if (await w.page.locator("#nav").isVisible()) throw new Error("Space opened the detail instead of picking");
      await w.page.keyboard.press("Space");
      await until("unpicked", async () => (await w.page.locator(".node.picked").count()) === 0, 4000);
      return "ok";
    } finally { await w.close(); }
  },
  // the route to the open screen can be exported as a video from the detail
  async exportsRouteVideo() {
    const w = await world([{ before: [init] }]);
    try {
      // two screens joined by an edge, so there is a route from the entry to the second one
      await w.page.close();
      const map = JSON.parse(await readFile(join(w.folder, "map.json"), "utf8"));
      map.screens.push({ ...map.screens[0], id: "a2-next", title: "Next", image: "screens/a1-home.png" });
      map.edges = [{ from: "a1-home", to: "a2-next", action: "tap", at: { x: 0, y: 0, w: 1, h: 1 } }];
      await writeFile(join(w.folder, "map.json"), JSON.stringify(map));
      await new Promise((r) => setTimeout(r, 500));
      const page = await w.browser.newPage();
      await page.goto(w.base + "/#/s/a2-next");
      await until("export button", () => page.locator("#exportRoute").isVisible());
      await page.click("#exportRoute");
      await until("saved message", async () => /Saved: .*route-a1-home-to-a2-next\.mp4/.test((await page.textContent("#exportMsg")) ?? ""), 60000);
      await until("copy button", () => page.locator("#exportCopy").isVisible());
      return "ok";
    } finally { await w.close(); }
  },
  // the export button belongs to a screen other than the entry, and its message belongs to the screen it was started for
  async exportButtonAndMessage() {
    const w = await world([{ before: [init] }]);
    try {
      const map = JSON.parse(await readFile(join(w.folder, "map.json"), "utf8"));
      map.screens.push({ ...map.screens[0], id: "a2-next", title: "Next", image: "screens/a1-home.png" });
      map.edges = [{ from: "a1-home", to: "a2-next", action: "tap", at: { x: 0, y: 0, w: 1, h: 1 } }];
      await writeFile(join(w.folder, "map.json"), JSON.stringify(map));
      await new Promise((r) => setTimeout(r, 500));
      const page = await w.browser.newPage();
      await page.goto(w.base + "/#/s/a1-home");
      await until("export button present", async () => (await page.locator("#exportRoute").count()) === 1);
      await new Promise((r) => setTimeout(r, 800));
      if (!(await page.locator("#exportRoute").isDisabled())) throw new Error("export is enabled on the entry screen");
      await page.evaluate(() => { location.hash = "#/s/a2-next"; });
      await until("export enabled on another screen", async () => !(await page.locator("#exportRoute").isDisabled()));
      await page.route("**/__flowmap-app/export-route", async (route: Route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
      await page.click("#exportRoute");
      await page.evaluate(() => { location.hash = "#/s/a1-home"; }); // leave the screen while it renders
      await new Promise((r) => setTimeout(r, 400));
      const progress = (await page.textContent("#exportMsg")) ?? "";
      if (progress.trim() !== "") throw new Error(`the progress text of another screen is shown: "${progress}"`);
      await new Promise((r) => setTimeout(r, 5600));
      const text = (await page.textContent("#exportMsg")) ?? "";
      if (/Saved/.test(text)) throw new Error(`the message of another screen is shown: "${text}"`);
      return "ok";
    } finally { await w.close(); }
  },
  // an empty map says what to do and where it lives, and its "New screen" section is open and ready to use
  async emptyMapStart() {
    const { page, base, folder, close } = await emptyWorld();
    try {
      await page.goto(base + "/");
      await until("empty state shown", () => page.locator("#empty").isVisible());
      const text = (await page.textContent("#empty")) ?? "";
      if (!/no screens yet/i.test(text)) throw new Error(`the empty state does not say there are no screens yet: "${text}"`);
      if (!/New screen/.test(text)) throw new Error(`the empty state does not point to "New screen": "${text}"`);
      const real = await realpath(folder);
      if (!text.includes(real)) throw new Error(`the empty state does not show the map folder ${real}: "${text}"`);
      if ((await page.locator('#empty button:has-text("Copy path")').count()) !== 1) throw new Error("the empty state has no Copy path button");
      if ((await page.getAttribute(tab("New screen"), "aria-selected")) !== "true") throw new Error("the New screen tab is not selected on an empty map");
      if (!(await page.locator("#nsTitle").isVisible()) || (await page.locator("#nsTitle").isDisabled())) throw new Error("the title field is not usable");
      if (await page.locator("#nsSend").isDisabled()) throw new Error("Ask for the screen is disabled with no screen selected");
      return "ok";
    } finally { await close(); }
  },
  // redesign 2: an empty map opens a starter card with examples that fill the New screen form
  async emptyStarter() {
    const e = await emptyWorld();
    try {
      await e.page.setViewportSize({ width: 1440, height: 900 });
      await e.page.goto(e.base + "/");
      await until("empty state shown", () => e.page.locator("#empty").isVisible());
      await until("dock shown", () => e.page.locator("#ask").isVisible());
      const geo = await e.page.evaluate(() => {
        const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
        const empty = box("empty"), view = box("view"), dock = box("ask");
        const link = Array.from(document.querySelectorAll("#empty a")).find((a) => a.textContent!.trim() === "Open another map…");
        return {
          width: empty.width, top: empty.top, bottom: empty.bottom, centreOffset: Math.abs(empty.left + empty.width / 2 - (view.left + view.width / 2)), dockTop: dock.top,
          heading: Array.from(document.querySelectorAll("#empty h1, #empty h2, #empty h3")).map((h) => h.textContent!.trim()),
          code: document.querySelector("#empty code")?.textContent ?? null,
          link: link ? { path: new URL((link as HTMLAnchorElement).href).pathname, height: link.getBoundingClientRect().height } : null,
        };
      });
      if (geo.centreOffset > 48) throw new Error(`the starter is ${geo.centreOffset}px off the horizontal centre of the canvas, at most 48 allowed`);
      if (geo.width > 800) throw new Error(`the starter is ${geo.width}px wide: it should be a card, at most 800 allowed`);
      if (geo.top < 48 || geo.bottom > geo.dockTop) throw new Error(`the starter spans ${geo.top}..${geo.bottom}px, it must sit below the bar (48) and above the dock (${geo.dockTop})`);
      if (!geo.heading.includes("Start your map")) throw new Error(`no heading "Start your map" in the empty state: ${JSON.stringify(geo.heading)}`);
      const real = await realpath(e.folder);
      if (geo.code !== real) throw new Error(`the folder path in <code> is ${JSON.stringify(geo.code)}, expected ${real}`);
      if ((await e.page.locator('#empty button:has-text("Copy path")').count()) !== 1) throw new Error("the Copy path button is gone");
      if (!geo.link || geo.link.path !== "/choose" || geo.link.height < 24) throw new Error(`"Open another map…" link is ${JSON.stringify(geo.link)}, expected /choose and at least 24px tall`);

      const titles: string[] = [];
      for (const example of ["Sign in screen", "Home dashboard", "Welcome / onboarding"]) {
        await e.page.click(tab("Change the map"));
        await e.page.click(`#empty button:has-text("${example}")`);
        const title = await e.page.inputValue("#nsTitle");
        if (!title || !(await e.page.inputValue("#nsDescription"))) throw new Error(`"${example}" left the title or the description empty`);
        titles.push(title);
        if ((await e.page.getAttribute(tab("New screen"), "aria-selected")) !== "true") throw new Error(`"${example}" did not select the New screen tab`);
        const focused = await e.page.evaluate(() => document.activeElement?.id);
        if (focused !== "nsDescription") throw new Error(`after "${example}" the focus is on #${focused}, expected #nsDescription`);
      }
      if (new Set(titles).size !== 3) throw new Error(`the three examples fill the same title: ${JSON.stringify(titles)}`);

      const w = await world([{ before: [init] }]);
      try {
        await w.page.goto(w.base + "/");
        await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
        if (await w.page.locator("#empty").isVisible()) throw new Error("the starter is visible on a map with screens");
      } finally { await w.close(); }
      return "ok";
    } finally { await e.close(); }
  },
  // redesign 2: a failed run stays on its card with the error; Try again re-sends the same request, Dismiss brings the dock back
  async tryAgain() {
    const failure = { type: "result", subtype: "error_during_execution", is_error: true, result: "Claude could not finish", session_id: SESSION_ID };
    const w = await world([{ before: [init], hold: true, after: [failure] }, { before: [init], hold: true, after: [failure] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      const posts: { path: string; body: string | null }[] = [];
      await w.page.route("**/__flowmap-app/request", async (route: Route) => { posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() }); await route.continue(); });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const card = () => w.page.evaluate(() => {
        const el = document.getElementById("runCard")!;
        return { visible: el.checkVisibility(), failed: el.classList.contains("fail") || el.dataset.state === "failed", text: el.textContent ?? "" };
      });
      const failedCard = async () => { const c = await card(); return c.visible && c.failed; };
      await sendRun(w, "Make it blue");
      await until("Running…", async () => (await w.page.textContent("#askMsg")) === "Running…");
      await w.fake.release();
      await until("failed card", failedCard);
      const failed = await card();
      if (!failed.text.includes("Claude could not finish")) throw new Error(`the failed card does not show the error: "${failed.text}"`);
      if ((await w.page.textContent("#runRetry"))?.trim() !== "Try again") throw new Error("no #runRetry button labelled \"Try again\"");
      if ((await w.page.textContent("#runDismiss"))?.trim() !== "Dismiss") throw new Error("no #runDismiss button labelled \"Dismiss\"");
      if (await w.page.locator("#ask").isVisible()) throw new Error("the dock is visible while the failed card waits for an answer");

      // the retry sends what failed, not what the box says now
      await w.page.evaluate(() => { (document.getElementById("askText") as HTMLTextAreaElement).value = "something else"; });
      await w.page.click("#runRetry");
      await until("second request posted", async () => posts.length === 2);
      if (posts[0].path !== "/__flowmap-app/request" || !posts[0].body?.includes("Make it blue")) throw new Error(`the first request is ${JSON.stringify(posts[0])}`);
      if (posts[1].path !== posts[0].path || posts[1].body !== posts[0].body) throw new Error(`the retry sent ${JSON.stringify(posts[1])}, not the request that failed ${JSON.stringify(posts[0])}`);
      await until("card back to running", async () => { const c = await card(); return c.visible && !c.failed; });
      if (await w.page.locator("#runRetry").isVisible()) throw new Error("Try again is still visible while the run goes on");

      await w.fake.release();
      await until("failed card again", failedCard);
      await w.page.click("#runDismiss");
      await until("card hidden", async () => !(await card()).visible);
      await until("dock back", () => w.page.locator("#ask").isVisible());
      return "ok";
    } finally { await w.close(); }
  },
  // redesign 2: a + button picks images into the same pending strip as paste, and the comments checkbox says how many comments it attaches
  async attachButtonAndCount() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const label = async () => ((await w.page.evaluate(() => document.getElementById("askAttach")!.closest("label")!.textContent)) ?? "").trim();
      if ((await label()) !== "Attach my comments (0)") throw new Error(`the label reads "${await label()}" with no comments, expected "Attach my comments (0)"`);
      await mkdir(join(w.folder, "temp"), { recursive: true });
      const comment = (n: number) => ({ id: `a1-home-0${n}`, screen: "a1-home", rect: { x: 0, y: 0, w: 1, h: 1 }, comment: `Comment ${n}`, crop: `temp/a1-home-0${n}.png`, fingerprint: "f", at: "2026-11-07T00:00:00+00:00" });
      await writeFile(join(w.folder, "temp", "annotations.json"), JSON.stringify({ version: 1, seq: { "a1-home": 2 }, annotations: [comment(1), comment(2)] }));
      await w.page.reload();
      await until("label counts the saved comments", async () => (await label()) === "Attach my comments (2)");

      const button = await w.page.evaluate(() => {
        const b = document.getElementById("askAttachBtn"), input = document.getElementById("askFile") as HTMLInputElement | null;
        const box = b?.getBoundingClientRect();
        return { label: b?.getAttribute("aria-label") ?? null, width: box?.width ?? 0, height: box?.height ?? 0, inForm: Boolean(b?.closest("#askForm")), type: input?.type ?? null, accept: input?.accept ?? null, hidden: input?.hidden ?? null };
      });
      if (button.label !== "Attach an image" || button.width < 32 || button.height < 32 || !button.inForm) throw new Error(`#askAttachBtn is ${JSON.stringify(button)}, expected an "Attach an image" button of at least 32x32 in the Change pane`);
      if (button.type !== "file" || button.accept !== "image/png,image/jpeg" || button.hidden !== true) throw new Error(`#askFile is ${JSON.stringify(button)}, expected a hidden file input accepting image/png,image/jpeg`);
      await w.page.evaluate(() => { (window as unknown as { pickerOpened: boolean }).pickerOpened = false; document.getElementById("askFile")!.addEventListener("click", (ev) => { ev.preventDefault(); (window as unknown as { pickerOpened: boolean }).pickerOpened = true; }); });
      await w.page.click("#askAttachBtn");
      if (!(await w.page.evaluate(() => (window as unknown as { pickerOpened: boolean }).pickerOpened))) throw new Error("clicking #askAttachBtn did not open the file picker");

      const png = (name: string, size = PNG.length) => ({ name, mimeType: "image/png", buffer: size === PNG.length ? PNG : Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]) });
      const thumbs = () => w.page.locator("#askImages .thumb").count();
      await w.page.setInputFiles("#askFile", [png("one.png")]);
      await until("one thumbnail", async () => (await thumbs()) === 1);
      const remove = await w.page.evaluate(() => { const box = document.querySelector("#askImages .thumb button")!.getBoundingClientRect(); return { width: box.width, height: box.height }; });
      if (remove.width < 24 || remove.height < 24) throw new Error(`the remove button of a thumbnail is ${remove.width}x${remove.height}, at least 24x24 needed`);
      await w.page.setInputFiles("#askFile", [{ name: "anim.gif", mimeType: "image/gif", buffer: PNG }]);
      await new Promise((r) => setTimeout(r, 500));
      if ((await thumbs()) !== 1) throw new Error("a GIF from the picker was taken");
      await w.page.setInputFiles("#askFile", [png("big.png", 5 * 1024 * 1024 + 1)]);
      await until("over 5 MB message", async () => (await w.page.textContent("#askMsg")) === "That image is over 5 MB.");
      if ((await thumbs()) !== 1) throw new Error("an image over 5 MB was taken");
      await w.page.setInputFiles("#askFile", [png("two.png"), png("three.png"), png("four.png")]);
      await until("at most 3 message", async () => (await w.page.textContent("#askMsg")) === "At most 3 images per request.");
      if ((await thumbs()) !== 3) throw new Error(`${await thumbs()} thumbnails after picking past the limit, expected 3`);

      // the picked images travel with the request like pasted ones
      let sent: { images?: unknown[] } = {};
      await w.page.route("**/__flowmap-app/request", async (route: Route) => { sent = JSON.parse(route.request().postData() ?? "{}"); await route.continue(); });
      await sendRun(w, "look at these");
      await until("request posted", async () => sent.images !== undefined);
      if (sent.images!.length !== 3) throw new Error(`the request carried ${sent.images!.length} images, expected 3`);
      return "ok";
    } finally { await w.close(); }
  },
  // redesign 2: the drawer is a 400 px column under the bar, with eyebrow section titles and one wrapping row of 32 px actions
  async drawerLayout() {
    const w = await world([{ before: [init] }]);
    try {
      const map = JSON.parse(await readFile(join(w.folder, "map.json"), "utf8"));
      map.screens.push({ ...map.screens[0], id: "a2-next", title: "Next", image: "screens/a1-home.png" });
      map.edges = [{ from: "a1-home", to: "a2-next", action: "tap", at: { x: 0, y: 0, w: 1, h: 1 } }];
      await writeFile(join(w.folder, "map.json"), JSON.stringify(map));
      await new Promise((r) => setTimeout(r, 500));
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/#/s/a2-next");
      await until("drawer open", () => w.page.locator("#nav").isVisible());
      const actions = ["rcSend", "copyShot", "exportRoute"];
      await until("the three actions are visible", async () => Object.values(await visibility(w.page, actions.map((id) => "#" + id))).every((v) => v === "shown"));
      const m = await w.page.evaluate((ids: string[]) => {
        const nav = document.getElementById("nav")!, box = nav.getBoundingClientRect();
        const sections = ["#outRail", 'nav[aria-label="Where you came from"]', "#history", "#annWrap"].map((sel) => {
          const section = document.querySelector(sel)!, h = section.querySelector("h3")!;
          const title = h.cloneNode(true) as HTMLElement;
          title.querySelectorAll(".count").forEach((c) => c.remove());
          const style = getComputedStyle(h);
          return { sel, radius: getComputedStyle(section).borderTopLeftRadius, title: title.textContent!.trim(), transform: style.textTransform, fontSize: parseFloat(style.fontSize), chip: h.querySelector(".count") !== null };
        });
        const buttons = ids.map((id) => document.getElementById(id)!);
        return {
          background: getComputedStyle(nav).backgroundColor, width: box.width, top: box.top, bottom: box.bottom, windowHeight: innerHeight,
          titleInHead: document.getElementById("navHead")!.contains(document.getElementById("stitle")),
          sections,
          heights: buttons.map((b) => b.getBoundingClientRect().height),
          rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
          sameParent: new Set(buttons.map((b) => b.parentElement)).size === 1,
          parent: { display: getComputedStyle(buttons[0].parentElement!).display, wrap: getComputedStyle(buttons[0].parentElement!).flexWrap },
        };
      }, actions);
      const problems: string[] = [];
      if (rgb(m.background).join() !== "18,22,27") problems.push(`#nav background is ${m.background}, expected the --panel token rgb(18, 22, 27)`);
      if (Math.abs(m.width - 400) > 0.5) problems.push(`#nav is ${m.width}px wide, expected 400`);
      if (Math.abs(m.top - 48) > 1) problems.push(`#nav starts ${m.top}px from the top, expected 48 (under the bar)`);
      if (Math.abs(m.bottom - m.windowHeight) > 1) problems.push(`#nav ends at ${m.bottom}px, expected the bottom of the window (${m.windowHeight}px)`);
      if (!m.titleInHead) problems.push("#stitle is not inside the head row #navHead");
      const names = ["leads to", "reached from", "history", "comments"];
      m.sections.forEach((s, i) => {
        if (s.radius !== "12px") problems.push(`${s.sel} has radius ${s.radius}, expected 12px`);
        if (s.title.toLowerCase() !== names[i] && !s.title.toLowerCase().startsWith(names[i] + " ")) problems.push(`the title of ${s.sel} reads "${s.title}", expected "${names[i]}"`);
        if (s.transform !== "uppercase" || s.fontSize > 12) problems.push(`the title of ${s.sel} is ${s.transform} ${s.fontSize}px, expected an uppercase eyebrow of at most 12px`);
        if (!s.chip) problems.push(`the title of ${s.sel} has no count chip`);
      });
      if (m.heights.some((h) => Math.abs(h - 32) > 0.5)) problems.push(`the actions are ${m.heights.join("/")}px tall (Re-capture, Copy screenshot, Export route), expected 32 each`);
      if (m.rows > 2) problems.push(`the actions take ${m.rows} rows, at most 2 allowed`);
      if (!m.sameParent || m.parent.display !== "flex" || m.parent.wrap !== "wrap") problems.push(`the actions are not one wrapping flex row: same parent ${m.sameParent}, ${m.parent.display}, ${m.parent.wrap}`);
      if (problems.length) throw new Error(problems.join("; "));
      return "ok";
    } finally { await w.close(); }
  },
  // the reset button is a confirmation step, not a toggle; the group hint tells how to pick from the keyboard
  async togglesAndHints() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      await new Promise((r) => setTimeout(r, 1000));
      if ((await w.page.getAttribute("#resetBtn", "aria-pressed")) !== null) throw new Error("resetBtn has aria-pressed");
      const hints = (await w.page.textContent("body")) + (await w.page.evaluate(() => Array.from(document.querySelectorAll("[title]")).map((e) => e.getAttribute("title")).join(" ")));
      if (!/Space/.test(hints)) throw new Error("no hint mentions the Space key");
      return "ok";
    } finally { await w.close(); }
  },
  // review FE1: the dock tabs follow the tabs pattern; their arrow keys do not drive the open screen behind them
  async tabKeyboard() {
    const w = await world([{ before: [init] }]);
    try {
      await addSecondScreen(w);
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/#/s/a1-home");
      await until("ask box and drawer", async () => (await w.page.locator("#ask").isVisible()) && (await w.page.locator("#nav").isVisible()));
      const state = () => w.page.evaluate(() => ({
        selected: Array.from(document.querySelectorAll("#dockTabs [role=tab]")).filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.id).join(),
        tabindex: Array.from(document.querySelectorAll("#dockTabs [role=tab]")).map((t) => `${t.id}=${t.getAttribute("tabindex")}`).join(" "),
        focused: document.activeElement?.id ?? "",
        screen: document.getElementById("stitle")!.textContent,
      }));
      const expectState = async (selected: string, tabindex: string, what: string) => {
        const s = await state();
        if (s.selected !== selected || s.tabindex !== tabindex || s.focused !== selected || s.screen !== "a1-home") throw new Error(`${what}: ${JSON.stringify(s)}, expected ${selected} selected, focused, ${tabindex}, and the open screen still a1-home`);
      };
      const rest = (zero: string) => ["tabChange", "tabNew", "tabCapture"].map((id) => `${id}=${id === zero ? 0 : -1}`).join(" ");
      if ((await state()).tabindex !== rest("tabChange")) throw new Error(`at the start: ${(await state()).tabindex}, expected ${rest("tabChange")}`);

      await w.page.locator("#tabNew").focus();
      await w.page.keyboard.press("ArrowRight");
      await expectState("tabCapture", rest("tabCapture"), "ArrowRight from New screen");
      await w.page.keyboard.press("ArrowRight");
      await expectState("tabChange", rest("tabChange"), "ArrowRight wraps to the first tab");
      await w.page.keyboard.press("ArrowLeft");
      await expectState("tabCapture", rest("tabCapture"), "ArrowLeft wraps to the last tab");
      await w.page.keyboard.press("Home");
      await expectState("tabChange", rest("tabChange"), "Home");
      await w.page.keyboard.press("End");
      await expectState("tabCapture", rest("tabCapture"), "End");

      await w.page.click("#tabNew");
      const clicked = await state();
      if (clicked.selected !== "tabNew" || clicked.tabindex !== rest("tabNew")) throw new Error(`after clicking New screen: ${JSON.stringify(clicked)}`);
      return "ok";
    } finally { await w.close(); }
  },
  // review FE2: on a phone the run card stacks above the open drawer, so its approval buttons can be pressed
  async mobileRunCardAboveDrawer() {
    const w = await world([{ before: [init, result("Blocked", [denial("npm test")])] }]);
    try {
      await w.page.setViewportSize({ width: 390, height: 844 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Run the tests");
      await until("approval box", () => w.page.locator("#runApproval").isVisible());
      await w.page.evaluate(() => { location.hash = "#/s/a1-home"; });
      await until("drawer open", () => w.page.locator("#nav").isVisible());
      const hit = await w.page.evaluate(() => {
        const centre = (id: string) => { const b = document.getElementById(id)!.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); };
        return { approvalInCard: Boolean(centre("runApproval")?.closest("#runCard")), closeIsClose: centre("toMap")?.id === "toMap" };
      });
      if (!hit.approvalInCard) throw new Error("the centre of #runApproval is covered by something outside #runCard (the drawer)");
      if (!hit.closeIsClose) throw new Error("the drawer's close button is not reachable while the run card is open");
      return "ok";
    } finally { await w.close(); }
  },
  // review FE3: the header never clips: it wraps onto a second row, and what sits under it starts at its real bottom
  async headerWraps() {
    const w = await world([{ before: [init] }]);
    try {
      await w.page.setViewportSize({ width: 390, height: 844 });
      await w.page.goto(w.base + "/");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      const bar = () => w.page.evaluate(() => {
        const header = document.querySelector("header")!, box = header.getBoundingClientRect();
        const controls = Array.from(document.querySelectorAll(".tools button, .tools input, .tools select")).filter((el) => el.checkVisibility());
        const title = document.getElementById("title")!.getBoundingClientRect();
        const nav = document.getElementById("nav")!;
        return {
          width: innerWidth, bottom: box.bottom, scroll: header.scrollWidth, client: header.clientWidth, title: title.width,
          clipped: controls.filter((el) => { const b = el.getBoundingClientRect(); return b.right > innerWidth + 0.5 || b.left < -0.5; }).map((el) => el.id || el.tagName),
          unreachable: ["navBtn", "changesBtn"].filter((id) => { const b = document.getElementById(id)!.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.id !== id; }),
          viewTop: document.getElementById("view")!.getBoundingClientRect().top,
          navTop: nav.hidden ? null : nav.getBoundingClientRect().top,
        };
      });
      const check = async (where: string, drawer: boolean) => {
        let b = await bar();
        await until(`what is under the header starts at its bottom ${where}`, async () => { b = await bar(); return Math.abs(b.viewTop - b.bottom) <= 1 && (!drawer || b.navTop !== null && Math.abs(b.navTop - b.bottom) <= 1); });
        const problems: string[] = [];
        if (b.clipped.length) problems.push(`controls past the window edge: ${b.clipped.join(", ")}`);
        if (b.unreachable.length) problems.push(`not reachable: ${b.unreachable.join(", ")}`);
        if (b.scroll > b.client) problems.push(`the header overflows (${b.scroll} > ${b.client})`);
        if (b.title < 1) problems.push(`the title has ${b.title}px`);
        if (problems.length) throw new Error(`${where}: ${problems.join("; ")}`);
      };
      await w.page.evaluate(() => { for (const id of ["groupBtn", "resetBtn", "sbsBtn", "copyTop"]) document.getElementById(id)!.hidden = false; });
      await check("at 390 wide", false);

      await w.page.setViewportSize({ width: 1100, height: 800 });
      await w.page.evaluate(() => { location.hash = "#/s/a1-home"; });
      await until("drawer open", () => w.page.locator("#nav").isVisible());
      await check("at 1100 wide with every optional button", true);
      return "ok";
    } finally { await w.close(); }
  },
  // review FE4: on a phone the message of a failed run gets room to be read
  async mobileFailedMessage() {
    const w = await world([{ before: [init], hold: true, after: [failedRun] }]);
    try {
      await w.page.setViewportSize({ width: 390, height: 844 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Make it blue");
      await until("Cancel button", () => w.page.locator("#runCancel").isVisible());
      await w.fake.release();
      await until("failed card", () => w.page.locator("#runRetry").isVisible());
      const width = await w.page.evaluate(() => document.getElementById("runMsg")!.getBoundingClientRect().width);
      if (width < 200) throw new Error(`the failure message is ${width}px wide, at least 200 needed`);
      return "ok";
    } finally { await w.close(); }
  },
  // review FE5: only the status line is a live region, the events are rewritten only when they change, the card's name follows the state
  async runLiveRegion() {
    const w = await world([{ before: [init, progress("Reading the map")], hold: true, after: [failedRun] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await spyOnRunMsg(w.page);
      await sendRun(w, "Make it blue");
      await until("events shown", async () => ((await w.page.textContent("#runEvents")) ?? "").includes("Reading the map"));
      const card = () => w.page.evaluate(() => {
        const el = document.getElementById("runCard")!, events = document.getElementById("runEvents")!, approval = document.getElementById("runApproval")!;
        const live = [el, ...Array.from(el.querySelectorAll("*"))].filter((n) => n.hasAttribute("aria-live") || ["status", "alert", "log"].includes(n.getAttribute("role") ?? ""));
        return { label: el.getAttribute("aria-label"), live: live.map((n) => ({ id: n.id || n.tagName, holdsEvents: n.contains(events), holdsApproval: n.contains(approval) })) };
      });
      const running = await card();
      if (running.label !== "Claude is working") throw new Error(`the running card is named "${running.label}"`);
      if (running.live.length === 0) throw new Error("the card has no live region for its status");
      const wide = running.live.filter((n) => n.holdsEvents || n.holdsApproval);
      if (wide.length) throw new Error(`the live region holds the events or the approval box: ${JSON.stringify(wide)}`);

      await w.page.evaluate(() => {
        (window as unknown as { eventWrites: number }).eventWrites = 0;
        new MutationObserver((records) => { (window as unknown as { eventWrites: number }).eventWrites += records.length; })
          .observe(document.getElementById("runEvents")!, { childList: true, characterData: true, subtree: true, attributes: true });
      });
      await new Promise((r) => setTimeout(r, 6500)); // three polls that bring the same events
      const writes = await w.page.evaluate(() => (window as unknown as { eventWrites: number }).eventWrites);
      if (writes !== 0) throw new Error(`#runEvents was rewritten ${writes} times over three polls that brought the same events`);

      await w.fake.release();
      await until("failed card", () => w.page.locator("#runRetry").isVisible());
      const stopped = await card();
      if (stopped.label !== "Claude stopped") throw new Error(`the failed card is named "${stopped.label}"`);
      const announced = await w.page.evaluate(() => (window as unknown as { runMsgWrites: { text: string; visible: boolean }[] }).runMsgWrites.filter((write) => write.text === "Claude could not finish"));
      if (announced.length === 0 || !announced[announced.length - 1].visible) throw new Error(`the failure text was written ${JSON.stringify(announced)}; it must be written while the card is visible to be announced`);
      return "ok";
    } finally { await w.close(); }
  },
  // review FE6: when the card or the dock swaps, the focus goes to the control that replaced the one pressed instead of being lost
  async focusAfterSwap() {
    const w = await world([{ before: [init], hold: true, after: [failedRun] }, { before: [init], hold: true, after: [failedRun] }, { before: [init], hold: true, after: [failedRun] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      const focus = () => w.page.evaluate(() => ({ id: document.activeElement?.id ?? "", inDock: document.getElementById("ask")!.contains(document.activeElement) && document.getElementById("ask")!.checkVisibility() }));
      await sendRun(w, "Make it blue");
      await until("focus on Cancel after Send", async () => (await focus()).id === "runCancel");
      await w.fake.release();
      await until("failed card", () => w.page.locator("#runDismiss").isVisible());
      await w.page.click("#runDismiss");
      await until("focus back in the dock after Dismiss", async () => (await focus()).inDock);

      await sendRun(w, "Make it red");
      await until("Cancel button", () => w.page.locator("#runCancel").isVisible());
      await w.fake.release();
      await until("failed card again", () => w.page.locator("#runRetry").isVisible());
      await w.page.click("#runRetry");
      await until("focus on Cancel after Try again", async () => (await focus()).id === "runCancel");
      await w.fake.release();
      return "ok";
    } finally { await w.close(); }
  },
  // review FE7: a retried run that rewrites the map reloads the page by itself: the request it sends again is not a draft
  async retryReloads() {
    const w = await world([{ before: [init], hold: true, after: [failedRun] }, { before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Make it blue");
      await until("Cancel button", () => w.page.locator("#runCancel").isVisible());
      await w.fake.release();
      await until("failed card", () => w.page.locator("#runRetry").isVisible());
      await w.page.click("#runRetry");
      await until("retried run going", async () => !(await w.page.locator("#runRetry").isVisible()) && (await w.page.locator("#runCancel").isVisible()));
      await w.page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
      await w.writeMap("Rewritten by the retry");
      const reloaded = () => w.page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument === undefined);
      await until("the page reloaded or offered the banner", async () => (await reloaded()) || (await w.page.locator("#mapChanged").isVisible()));
      if (!(await reloaded())) throw new Error("the page did not reload: #mapChanged was shown because the retried request still counted as a draft");
      if (await w.page.locator("#mapChanged").isVisible()) throw new Error("#mapChanged is shown after the reload");
      await w.fake.release();
      return "ok";
    } finally { await w.close(); }
  },
  // residual review R1: the zoom controls are one group that never splits across rows
  async zoomGroup() {
    const w = await world([{ before: [init] }]);
    try {
      const group = () => w.page.evaluate(() => {
        const el = document.getElementById("zoomGroup");
        const ids = ["zout", "zlabel", "zin", "zfit"];
        const tops = ids.map((id) => document.getElementById(id)!.getBoundingClientRect().top);
        const box = el?.getBoundingClientRect();
        const style = el && getComputedStyle(el);
        return {
          exists: Boolean(el), role: el?.getAttribute("role"), label: el?.getAttribute("aria-label"),
          holdsAll: ids.filter((id) => !el?.contains(document.getElementById(id))),
          spread: Math.max(...tops) - Math.min(...tops),
          left: box?.left, right: box?.right, height: box?.height, border: style?.borderTopWidth, radius: style?.borderTopLeftRadius,
          headerHeight: document.querySelector("header")!.getBoundingClientRect().height, width: innerWidth,
        };
      });
      await w.page.setViewportSize({ width: 390, height: 844 });
      await w.page.goto(w.base + "/");
      await until("nodes drawn", async () => (await w.page.locator(".node").count()) > 0);
      const phone = await group();
      if (!phone.exists) throw new Error("there is no #zoomGroup around the zoom controls");
      if (phone.role !== "group" || phone.label !== "Zoom") throw new Error(`#zoomGroup is role=${phone.role} aria-label=${phone.label}, expected group / Zoom`);
      if (phone.holdsAll.length) throw new Error(`not inside #zoomGroup: ${phone.holdsAll.join(", ")}`);
      if (phone.spread > 2) throw new Error(`at 390 wide the zoom controls are on different rows: their tops differ by ${phone.spread}px`);
      if (phone.left! < 0 || phone.right! > phone.width + 0.5) throw new Error(`at 390 wide #zoomGroup spans ${phone.left}..${phone.right} of a ${phone.width}px window`);

      await w.page.setViewportSize({ width: 1440, height: 900 });
      await until("header back to one row", async () => Math.abs((await group()).headerHeight - 48) <= 1);
      const desktop = await group();
      if (desktop.height !== 32) throw new Error(`#zoomGroup is ${desktop.height}px tall, expected 32`);
      if (desktop.border !== "1px" || parseFloat(desktop.radius!) < 8) throw new Error(`#zoomGroup is not one bordered pill: border ${desktop.border}, radius ${desktop.radius}`);
      return "ok";
    } finally { await w.close(); }
  },
  // residual review R2: answering the approval box leaves the focus on the card's Cancel button, not on the page body
  async approvalFocus() {
    const w = await world([
      { before: [init, result("Blocked", [denial("npm test")])] }, { before: [init], hold: true, after: [result("All done")] },
      { before: [init, result("Blocked again", [denial("npm run build")])] },
    ]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      // the focus at the moment the approval box goes away, which is when the pressed button disappears
      await w.page.evaluate(() => {
        const box = document.getElementById("runApproval")!, seen: string[] = [];
        // only the change from shown to hidden counts: ending the run sets `hidden` again on a box that is already hidden
        new MutationObserver((records) => { for (const record of records) if (record.oldValue === null) seen.push(document.activeElement?.id || document.activeElement?.tagName || ""); }).observe(box, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
        (window as unknown as { focusAtDecision: string[] }).focusAtDecision = seen;
      });
      const answered = () => w.page.evaluate(() => (window as unknown as { focusAtDecision: string[] }).focusAtDecision);

      await sendRun(w, "Run the tests");
      await until("approval box", () => w.page.locator("#runApproval").isVisible());
      await w.page.click("#runApproval input[type=checkbox]");
      await w.page.click("#runApproval button.pri");
      await until("approval box answered", async () => (await answered()).length === 1);
      const afterAllow = (await answered())[0];
      if (afterAllow !== "runCancel") throw new Error(`after Allow the focus is on "${afterAllow}", expected runCancel`);
      await w.fake.release();
      await until("run done", async () => !(await w.page.locator("#runCard").isVisible()));

      await sendRun(w, "Build it");
      await until("approval box again", () => w.page.locator("#runApproval").isVisible());
      await w.page.click("#runApproval .actions button:not(.pri)");
      await until("approval box denied", async () => (await answered()).length === 2);
      const afterDeny = (await answered())[1];
      if (afterDeny !== "runCancel") throw new Error(`after Deny the focus is on "${afterDeny}", expected runCancel`);
      return "ok";
    } finally { await w.close(); }
  },
  // residual review R3: on a phone the approval text is read in full: it wraps instead of ending in an ellipsis
  async mobileApprovalText() {
    const command = "cat /Users/someone/projects/a-very-long-folder-name/another-long-folder-name/the-file-name-that-is-long.txt";
    const w = await world([{ before: [init, result("Blocked", [denial(command)])] }]);
    try {
      await w.page.setViewportSize({ width: 390, height: 844 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await sendRun(w, "Show the file");
      await until("approval box", () => w.page.locator("#runApproval").isVisible());
      await until("permission text", async () => (await w.page.textContent("#runMsg")) === "Claude needs your permission to continue.");
      const lines = await w.page.evaluate(() => {
        const card = document.getElementById("runCard")!.getBoundingClientRect();
        return [document.getElementById("runMsg")!, ...Array.from(document.querySelectorAll<HTMLElement>("#runApproval label"))].map((el) => {
          const style = getComputedStyle(el);
          return { name: el.id || (el.textContent ?? "").slice(0, 30), scroll: el.scrollWidth, client: el.clientWidth, overflow: style.textOverflow, wrap: style.whiteSpace, past: el.getBoundingClientRect().right - card.right };
        });
      });
      const problems = lines.filter((line) => line.scroll > line.client || line.overflow === "ellipsis" || line.wrap === "nowrap" || line.past > 0.5);
      if (problems.length) throw new Error(`text clipped on a phone: ${JSON.stringify(problems)}`);
      return "ok";
    } finally { await w.close(); }
  },
  // residual review R4: "Running…" is written to the status line while the run card is on screen, so it is announced
  async runningAnnounced() {
    const w = await world([{ before: [init], hold: true, after: [result("All done")] }]);
    try {
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      await until("ask box", () => w.page.locator("#ask").isVisible());
      await spyOnRunMsg(w.page);
      await sendRun(w, "Make it blue");
      await until("Cancel button", () => w.page.locator("#runCancel").isVisible());
      const writes = await w.page.evaluate(() => (window as unknown as { runMsgWrites: { text: string; visible: boolean }[] }).runMsgWrites.filter((write) => write.text === "Running…"));
      if (writes.length === 0) throw new Error("\"Running…\" was never written to #runMsg");
      if (writes.some((write) => !write.visible)) throw new Error(`"Running…" was written while the run card was hidden: ${JSON.stringify(writes)}`);
      await w.fake.release();
      return "ok";
    } finally { await w.close(); }
  },
  // the Connections button hides every edge (line, arrowhead, label) without redrawing the map, remembers the choice per browser, and E toggles it
  async connectionsToggle() {
    const w = await world([{ before: [init] }]);
    try {
      const map = JSON.parse(await readFile(join(w.folder, "map.json"), "utf8"));
      const screen = (id: string) => ({ ...map.screens[0], id, title: id });
      map.screens = [screen("a1-home"), screen("a2-next"), screen("a3-last")];
      map.edges = [
        { from: "a1-home", to: "a2-next", action: "tap start", at: { x: 0, y: 0, w: 1, h: 1 } },
        { from: "a2-next", to: "a3-last", action: "tap continue", at: { x: 0, y: 0, w: 1, h: 1 } },
      ];
      map.frontier = [{ from: "a3-last", action: "open settings" }];
      await writeFile(join(w.folder, "map.json"), JSON.stringify(map));
      await w.page.setViewportSize({ width: 1440, height: 900 });
      await w.page.goto(w.base + "/");
      const ready = async () => (await w.page.locator(".node").count()) === 3;
      await until("three nodes drawn", ready);
      // what is on screen: edge lines and labels (the unexplored stub and its label are not connections yet), screens, their title tags and the flow headings
      const look = () => w.page.evaluate(() => {
        const shown = (el: Element) => { const b = el.getBoundingClientRect(); return el.checkVisibility() && (b.width > 0 || b.height > 0); };
        const count = (sel: string) => Array.from(document.querySelectorAll(sel)).filter(shown).length;
        return {
          pressed: document.getElementById("edgesBtn")?.getAttribute("aria-pressed") ?? "missing",
          edgeLines: count('#svg > path:not([stroke="#e0a63a"])'), edgeLabels: count(".lab:not(.f)"),
          nodes: count(".node"), tags: count(".node .tag"), zones: count(".zone"), frontier: count(".lab.f"),
        };
      });
      const start = await look();
      if (start.pressed !== "true") throw new Error(`by default aria-pressed is ${start.pressed}, expected true`);
      if (start.edgeLines < 2 || start.edgeLabels !== 2) throw new Error(`by default the edges are not drawn: ${JSON.stringify(start)}`);
      if (start.nodes !== 3 || start.zones < 1 || start.frontier !== 1) throw new Error(`the fixture is not what the scenario expects: ${JSON.stringify(start)}`);
      const hiddenState = { ...start, pressed: "false", edgeLines: 0, edgeLabels: 0 };
      const expectHidden = async (when: string) => {
        const now = await look();
        if (JSON.stringify(now) !== JSON.stringify(hiddenState)) throw new Error(`${when}: expected ${JSON.stringify(hiddenState)}, got ${JSON.stringify(now)}`);
      };

      await w.page.click("#edgesBtn");
      await expectHidden("after clicking Connections");
      await w.page.click("#edgesBtn");
      const again = await look();
      if (JSON.stringify(again) !== JSON.stringify(start)) throw new Error(`clicking again did not restore the map: ${JSON.stringify(again)} vs ${JSON.stringify(start)}`);

      await w.page.keyboard.press("e");
      await expectHidden("after pressing E");
      await w.page.locator("#q").focus();
      await w.page.keyboard.press("e");
      await w.page.fill("#q", "");
      await expectHidden("after typing an e in the search box");

      await w.page.reload();
      await until("three nodes drawn after the reload", ready);
      await expectHidden("after a reload");
      await w.page.evaluate(() => localStorage.clear());
      await w.page.reload();
      await until("three nodes drawn after clearing the storage", ready);
      const cleared = await look();
      if (JSON.stringify(cleared) !== JSON.stringify(start)) throw new Error(`with the storage cleared the connections are not shown: ${JSON.stringify(cleared)}`);

      await w.page.addInitScript(() => {
        const refuse = () => { throw new DOMException("blocked", "SecurityError"); };
        Storage.prototype.getItem = refuse;
        Storage.prototype.setItem = refuse;
      });
      await w.page.reload();
      await until("three nodes drawn with the storage blocked", ready);
      const blocked = await look();
      if (JSON.stringify(blocked) !== JSON.stringify(start)) throw new Error(`with the storage blocked the connections are not shown: ${JSON.stringify(blocked)}`);
      return "ok";
    } finally { await w.close(); }
  },
};

const wanted = process.argv.slice(2);
let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try { console.log("PASS", name, await run()); } catch (e) { failed++; console.log("FAIL", name, (e as Error).message); }
}
process.exit(failed ? 1 : 0);
