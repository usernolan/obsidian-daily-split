"use strict";
/*
 * daily-split core logic — pure, dependency-free, environment-agnostic.
 *
 * splitMarkdown(text) -> { resolved, active }
 *   resolved : keep subtrees that contain a completed item (the "old day" archive)
 *   active   : keep subtrees that contain an unfinished item (the "next day" set)
 *
 * Scope (which lines are eligible to migrate):
 *   The note is segmented into regions — the preamble (everything before the first
 *   header) and one region per header (header + lines up to the next header, any level).
 *   A region "participates" in the split only if it is a header-region that contains at
 *   least one checkbox. Non-participating regions — the preamble and any checklist-free
 *   section — are untouched: kept verbatim on the old day, absent from the next day.
 *
 * Within a participating region the split is tree-aware: an item is kept if any node in
 * its subtree is kept, so all ancestor lines — up to and including the section header —
 * are preserved on each side. Item text, indentation and checkbox state are emitted
 * verbatim; blank-line spacing between regions is normalized to a single blank line.
 *
 * Conventions:
 *   - Only `[x]` / `[X]` counts as done. Any other marker (space, `/`, `-`, ...) is
 *     treated as active, so in-progress items carry forward to the next day.
 *   - A participating section's header is dropped from either side when nothing survives
 *     under it (no completed item -> gone from the old day; no active item -> gone from
 *     the next day). Untouched regions (preamble, checklist-free sections) are unaffected.
 *
 * Also runnable as a CLI:  node core.js <file.md>
 */

const HEADING_RE = /^#{1,6}\s/;
const CHECKBOX_RE = /^(\s*)- \[(.)\]\s/;
const BULLET_RE = /^(\s*)[-*+]\s/;

// "heading" | "checkbox" | "bullet" | "blank" | "other"
function classify(line) {
  if (line.trim() === "") return { type: "blank" };
  if (HEADING_RE.test(line)) return { type: "heading", indent: -1 };

  const cb = line.match(CHECKBOX_RE);
  if (cb) {
    const marker = cb[2];
    return {
      type: "checkbox",
      indent: cb[1].length,
      checked: marker === "x" || marker === "X",
    };
  }

  const bullet = line.match(BULLET_RE);
  if (bullet) return { type: "bullet", indent: bullet[1].length };

  // Free prose / anything else. Use its own leading whitespace as indent so it nests.
  return { type: "other", indent: line.match(/^\s*/)[0].length };
}

// Drop leading/trailing blank lines, preserving internal ones.
function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

// Collapse any run of blank lines to a single one and strip leading/trailing blanks,
// so the only blank lines left are single spacers between blocks.
function normalizeBlanks(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const blank = line.trim() === "";
    if (blank && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(blank ? "" : line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function splitMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");

  // Segment into regions: the preamble, then one per header line (any level).
  const regions = [];
  let current = { isSection: false, lines: [] };
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      regions.push(current);
      current = { isSection: true, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  regions.push(current);

  const resolvedBlocks = [];
  const activeBlocks = [];
  for (const region of regions) {
    const participates =
      region.isSection && region.lines.some((l) => CHECKBOX_RE.test(l));
    if (!participates) {
      // Untouched: stays on the old day verbatim; absent from the next day.
      const block = trimBlankEdges(region.lines).join("\n");
      if (block) resolvedBlocks.push(block);
      continue;
    }
    const { resolved, active } = splitSection(region.lines);
    if (resolved) resolvedBlocks.push(resolved);
    if (active) activeBlocks.push(active);
  }

  return {
    resolved: normalizeBlanks(resolvedBlocks.join("\n\n")),
    active: normalizeBlanks(activeBlocks.join("\n\n")),
  };
}

// Tree-aware split of a single participating section (header + its lines).
function splitSection(raw) {
  // Build nodes for every non-blank line, with parent links via an indent stack.
  const nodes = [];
  const stack = []; // entries: the node objects, ordered by ascending indent

  for (const line of raw) {
    const info = classify(line);
    if (info.type === "blank") continue;

    const node = {
      line,
      type: info.type,
      indent: info.indent,
      checked: info.checked === true,
      children: [],
      hasChecked: false,
      hasUnchecked: false,
    };

    if (info.type === "heading") {
      // Headings reset the hierarchy and become top-level parents.
      stack.length = 0;
      nodes.push(node);
      stack.push(node);
      continue;
    }

    // Pop until the top is a strictly shallower potential parent.
    while (stack.length && stack[stack.length - 1].indent >= node.indent) {
      stack.pop();
    }
    node.parent = stack[stack.length - 1] || null;
    if (node.parent) node.parent.children.push(node);
    nodes.push(node);
    stack.push(node);
  }

  // Bottom-up flags: does this subtree contain a checked / an unchecked checkbox?
  function annotate(node) {
    let checked = node.type === "checkbox" && node.checked;
    let unchecked = node.type === "checkbox" && !node.checked;
    for (const child of node.children) {
      annotate(child);
      checked = checked || child.hasChecked;
      unchecked = unchecked || child.hasUnchecked;
    }
    node.hasChecked = checked;
    node.hasUnchecked = unchecked;
  }
  for (const node of nodes) {
    if (!node.parent) annotate(node);
  }

  // Nearest ancestor that is a checkbox, or null.
  const checkboxAncestor = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === "checkbox") return p;
    }
    return null;
  };

  const keepNonHeading = (node, side) => {
    // Checkboxes — and any non-checkbox node that groups checkboxes beneath it — are kept
    // wherever their own subtree survives.
    if (node.type === "checkbox" || node.hasChecked || node.hasUnchecked) {
      return side === "resolved" ? node.hasChecked : node.hasUnchecked;
    }
    // A plain note (bullet or prose with no checkbox under it) travels with the task it
    // annotates: keep it wherever its nearest checkbox ancestor is kept, so notes ride
    // along with their `- [ ]` / `- [x]` parent until that task is done.
    const task = checkboxAncestor(node);
    if (task) return side === "resolved" ? task.hasChecked : task.hasUnchecked;
    // No task context at all -> keep on both sides so a standalone note is never lost.
    return true;
  };

  // Does a section (heading subtree) contain any line that survives on this side?
  const sectionHasKept = (node, side) => {
    for (const child of node.children) {
      if (keepNonHeading(child, side) || sectionHasKept(child, side)) return true;
    }
    return false;
  };

  const keep = (node, side) => {
    if (node.type === "heading") {
      // Drop a section header on either side when nothing survives under it.
      return sectionHasKept(node, side);
    }
    return keepNonHeading(node, side);
  };

  const render = (side) => {
    const out = [];
    for (const node of nodes) {
      if (!keep(node, side)) continue;
      if (node.type === "heading" && out.length) out.push(""); // blank line before sections
      out.push(node.line);
    }
    return out.join("\n");
  };

  return { resolved: render("resolved"), active: render("active") };
}

// Increment a YYYY-MM-DD date string by one day (UTC; rolls over months/years).
function nextDate(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`nextDate: expected YYYY-MM-DD, got "${dateStr}"`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { splitMarkdown, nextDate, classify };
}

// CLI: node core.js <file.md>  -> prints the two halves, writes <file>.resolved.md /
// the next-day sibling next to the source (date in the filename is incremented).
if (typeof require !== "undefined" && require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node core.js <daily-note.md>");
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  const { resolved, active } = splitMarkdown(text);

  const dir = path.dirname(file);
  const base = path.basename(file);
  const dateMatch = base.match(/\d{4}-\d{2}-\d{2}/);

  fs.writeFileSync(file, resolved);
  if (dateMatch) {
    const nextBase = base.replace(dateMatch[0], nextDate(dateMatch[0]));
    const nextPath = path.join(dir, nextBase);
    fs.writeFileSync(nextPath, active);
    console.error(`wrote ${file} (resolved) and ${nextPath} (active)`);
  } else {
    console.error(`wrote ${file} (resolved); no YYYY-MM-DD in name, active half:\n`);
    console.log(active);
  }
}
