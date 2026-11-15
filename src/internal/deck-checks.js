// Checks shared by createDeck and importDeck. Internal: not part of the package's public API.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeBlueprint } from "../blueprint.js";
import { loadGroup } from "../groups.js";
import { DeckExistsError, KitNotFoundError, ValidationError } from "../writer.js";

const DECK_NAME = /^[a-z0-9-]{1,60}$/;
const KINDS = new Set(["folder", "single"]);

export async function loadKit(group) {
  try {
    const loaded = await loadGroup(group);
    return { group: loaded, blueprint: normalizeBlueprint(loaded.blueprint, loaded.templates) };
  } catch (error) {
    if (/^Unknown template group|is not a valid name/.test(error.message)) throw new KitNotFoundError(group);
    throw new ValidationError(error.message, { code: "KIT_INVALID" });
  }
}

export function validateNewDeck({ name, title, kind, group }) {
  const fields = [];
  if (typeof name !== "string" || !DECK_NAME.test(name)) fields.push({ path: "name", message: "Use 1-60 lowercase letters, digits or dashes." });
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (cleanTitle.length < 1 || cleanTitle.length > 120) fields.push({ path: "title", message: "Use 1-120 characters." });
  if (!KINDS.has(kind)) fields.push({ path: "kind", message: "Use folder or single." });
  if (group != null && (typeof group !== "string" || !group.trim())) fields.push({ path: "group", message: "Use a kit name or null." });
  if (fields.length) throw new ValidationError("The new deck is not valid.", { fields });
  return { name, title: cleanTitle, kind, group: group == null ? null : group.trim() };
}

/** Refuses a name that exists, including one differing only in case (case-insensitive filesystems). */
export async function assertFree(dir, entryName) {
  const entries = await fs.readdir(dir);
  const clash = entries.find((entry) => entry.toLowerCase() === entryName.toLowerCase());
  if (clash) throw new DeckExistsError(path.join(dir, clash));
}
