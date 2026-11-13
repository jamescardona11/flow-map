import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Recent } from "./recents.ts";

const PLACEHOLDER = "<!--__FLOWMAP_RECENTS__-->";
const NOTICE_PLACEHOLDER = "<!--__FLOWMAP_NOTICE__-->";
const CHOOSER_PATH = join(import.meta.dirname, "choose-folder.html");

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

function renderCard({ path, title }: Recent, label = ""): string {
  const eyebrow = label && `<em>${escapeHtml(label)}</em>`;
  return (
    `<button type="button" class="recent" data-path="${escapeHtml(path)}">` +
    `${eyebrow}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(path)}</span></button>`
  );
}

function renderMaps(recents: Recent[], workingMap: Recent | null): string {
  const working = workingMap ? `<ul id="working"><li>${renderCard(workingMap, "Working map")}</li></ul>` : "";
  if (recents.length === 0) return working;
  const items = recents.map((recent) => `<li>${renderCard(recent)}</li>`);
  return `${working}<h2>Recent maps</h2><ul id="recents">${items.join("")}</ul>`;
}

/**
 * The choose-a-folder page with the working map (the scratch map, when it exists) and the recent maps listed in it
 * and, when given, a one-line notice above them.
 */
export async function buildChoosePage(recents: Recent[], notice = "", workingMap: Recent | null = null): Promise<string> {
  const page = await readFile(CHOOSER_PATH, "utf8");
  return page.replace(PLACEHOLDER, () => renderMaps(recents, workingMap)).replace(NOTICE_PLACEHOLDER, () => escapeHtml(notice));
}
