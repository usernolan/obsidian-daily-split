"use strict";
/*
 * daily-split — thin Obsidian glue around core.js.
 *
 * Adds a command and a ribbon button that "split" the active daily note:
 *   - the current note is pruned to completed items (the archive of this day);
 *   - a next-day note is created with the active set carried forward, then opened.
 *
 * All text logic lives in core.js (pure, also runnable via `node core.js`). This file
 * only handles Obsidian wiring: locating notes, reading/writing, folders, and UI.
 */

const { Plugin, Notice } = require("obsidian");
const path = require("path");

const DEFAULT_FORMAT = "YYYY/MM/YYYY-MM-DD";

module.exports = class DailySplitPlugin extends Plugin {
  onload() {
    // Load the pure core as a normal Node module (absolute path = robust, no build step).
    const corePath = path.join(
      this.app.vault.adapter.getBasePath(),
      this.manifest.dir,
      "core.js"
    );
    this.core = require(corePath);

    this.addCommand({
      id: "split-daily-note",
      name: "Split daily note → next day",
      callback: () => this.split(),
    });

    this.addRibbonIcon("list-checks", "Split daily note → next day", () =>
      this.split()
    );
  }

  // Daily-notes path format, e.g. "YYYY/MM/YYYY-MM-DD".
  dailyFormat() {
    const dn = this.app.internalPlugins.getPluginById("daily-notes");
    return (dn && dn.instance && dn.instance.options && dn.instance.options.format) || DEFAULT_FORMAT;
  }

  async ensureFolder(filePath) {
    const dir = filePath.split("/").slice(0, -1).join("/");
    if (!dir) return;
    const parts = dir.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          /* already exists / race — ignore */
        }
      }
    }
  }

  async split() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Daily Split: no active note.");
      return;
    }

    const dateMatch = file.basename.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) {
      new Notice("Daily Split: active note has no YYYY-MM-DD date in its name.");
      return;
    }

    const next = this.core.nextDate(dateMatch[0]);
    const nextPath =
      window.moment(next, "YYYY-MM-DD").format(this.dailyFormat()) + ".md";

    const content = await this.app.vault.read(file);
    const { resolved, active } = this.core.splitMarkdown(content);

    await this.ensureFolder(nextPath);
    const existing = this.app.vault.getAbstractFileByPath(nextPath);
    let nextFile;
    let verb;
    if (existing) {
      // Append the active set to the existing next-day note rather than overwriting it.
      const prior = (await this.app.vault.read(existing)).replace(/\s*$/, "");
      const merged = !active ? prior : prior ? prior + "\n\n" + active : active;
      await this.app.vault.modify(existing, merged);
      nextFile = existing;
      verb = "appended to";
    } else {
      nextFile = await this.app.vault.create(nextPath, active);
      verb = "created";
    }

    await this.app.workspace.getLeaf(false).openFile(nextFile);

    // Prune the source note; if nothing was completed it becomes empty -> remove it.
    if (resolved.trim() === "") {
      await this.app.fileManager.trashFile(file);
      new Notice(`Daily Split: ${verb} ${nextPath}; removed empty ${file.path}`);
    } else {
      await this.app.vault.modify(file, resolved);
      new Notice(`Daily Split: ${verb} ${nextPath}`);
    }
  }
};
