/**
 * Resolve the assistant's display name from `IDENTITY.md`.
 *
 * The workspace root is derived from the plugin's storage directory, which the
 * host sets to one of two layouts depending on whether this is a user-installed
 * plugin or a first-party default:
 *
 *   user plugin:   <workspace>/plugins/<plugin-name>/data/   (3 levels up)
 *   default plugin: <workspace>/plugins-data/<plugin>/        (2 levels up)
 *
 * Both are probed. `IDENTITY.md` is a markdown file whose name lives in a
 * `name:` field, a `- **Name:** ...` bullet (the standard Vellum template), or
 * the first `# Heading`. The parse is intentionally forgiving: a missing or
 * unparsable file returns `null` so the caller can fall back to Recall's
 * default rather than failing the init hook.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Derive the workspace root from the plugin storage directory by trying the
 * two known layouts. Returns `null` when neither resolves to a directory
 * containing an `IDENTITY.md`.
 */
function resolveWorkspaceDir(pluginStorageDir: string): string | null {
  const storage = resolve(pluginStorageDir);

  // User plugin: <workspace>/plugins/<plugin-name>/data/ — 3 levels up.
  const userWorkspace = dirname(dirname(dirname(storage)));
  if (existsSync(join(userWorkspace, "IDENTITY.md"))) {
    return userWorkspace;
  }

  // Default plugin: <workspace>/plugins-data/<plugin>/ — 2 levels up.
  const defaultWorkspace = dirname(dirname(storage));
  if (existsSync(join(defaultWorkspace, "IDENTITY.md"))) {
    return defaultWorkspace;
  }

  return null;
}

/**
 * Parse the assistant name from the contents of `IDENTITY.md`.
 *
 * Recognized forms (first match wins):
 *   - A plain `name:` field on its own line (e.g. `name: ApolloBot`).
 *   - A markdown bullet with a bold-or-plain `Name:` key, e.g.
 *     `- **Name:** Cade`, the form the standard Vellum IDENTITY.md template
 *     uses.
 *   - The first top-level `# Heading`.
 *
 * Placeholder values like `_(not yet chosen)_` and the file's own title
 * heading (`# IDENTITY.md`) are rejected so an unconfigured identity does not
 * become a bot name.
 */
export function parseIdentityName(content: string): string | null {
  const lines = content.split("\n");

  // 1. A plain `name:` field (YAML-ish front matter or plain line). Checked
  //    first so an explicit field wins over a template bullet or heading.
  const nameField = lines.find((l) => /^\s*name:\s*(.+)/i.test(l));
  if (nameField) {
    const match = nameField.match(/^\s*name:\s*(.+)/i);
    const name = cleanValue(match?.[1]);
    if (name && !isPlaceholder(name)) return name;
  }

  // 2. A markdown bullet with a bold-or-plain `Name:` key, e.g.
  //    `- **Name:** Cade` or `* Name: Cade`. This is the format the standard
  //    Vellum IDENTITY.md template uses.
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s*\*{0,2}name\*{0,2}:\s*(.+)/i);
    if (bullet) {
      const name = cleanValue(bullet[1]);
      if (name && !isPlaceholder(name)) return name;
    }
  }

  // 3. First H1 heading.
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    if (h1) {
      const name = cleanValue(h1[1]);
      if (name && !isPlaceholder(name)) return name;
    }
  }

  return null;
}

/**
 * Trim a parsed value and strip surrounding markdown emphasis (`*`/`_`) so a
 * bolded value like `**Cade**` resolves to `Cade`.
 */
function cleanValue(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^[*_]+/, "")
    .replace(/[*_]+$/, "")
    .trim();
}

function isPlaceholder(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return (
    lower.startsWith("_(not") ||
    lower.startsWith("(not") ||
    lower.includes("not yet") ||
    lower === "identity.md" ||
    lower.length === 0
  );
}

/**
 * Resolve the assistant name from `<workspace>/IDENTITY.md`. Returns `null`
 * when the file is absent or no name can be parsed — the caller should then
 * let Recall use its own default.
 */
export function resolveAssistantName(pluginStorageDir: string): string | null {
  const workspace = resolveWorkspaceDir(pluginStorageDir);
  if (!workspace) return null;

  let content: string;
  try {
    content = readFileSync(join(workspace, "IDENTITY.md"), "utf-8");
  } catch {
    return null;
  }

  return parseIdentityName(content);
}
