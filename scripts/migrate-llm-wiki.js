#!/usr/bin/env node

/**
 * migrate-llm-wiki.js
 *
 * One-time migration script for wiki vault layouts.
 *
 * Two migrations are supported:
 *
 * 1. LEGACY → NEW (default): moves an old-style vault (`.wiki/` sentinel)
 *    to the new `.llm-wiki/` layout.
 *
 * 2. DOUBLED → FLATTENED (`--fix-doubled`): flattens a vault that was
 *    accidentally created at `<root>/.llm-wiki/.llm-wiki/…` due to a bug in
 *    `getPersonalWikiRoot()` (fixed in 0.6.4). The extension auto-runs this
 *    migration on `session_start`, but the script is provided for manual
 *    recovery on arbitrary roots.
 *
 * Usage:
 *   node scripts/migrate-llm-wiki.js              # Legacy migration in cwd
 *   node scripts/migrate-llm-wiki.js ~/my-wiki     # Legacy migration at path
 *   node scripts/migrate-llm-wiki.js --dry-run     # Preview without changes
 *   node scripts/migrate-llm-wiki.js --force       # Skip confirmation prompt
 *   node scripts/migrate-llm-wiki.js --fix-doubled # Flatten doubled .llm-wiki/.llm-wiki
 *   node scripts/migrate-llm-wiki.js --fix-doubled ~/  # …at a specific root
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Helpers ────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const FIX_DOUBLED = process.argv.includes("--fix-doubled");

function log(action, ...args) {
  const prefix = DRY_RUN ? "[DRY-RUN]" : "[MIGRATE]";
  console.log(`${prefix} ${action}`, ...args);
}

function moveDir(src, dest, name) {
  if (!existsSync(src)) {
    log(`SKIP ${name} — source does not exist: ${src}`);
    return;
  }
  if (existsSync(dest)) {
    log(`SKIP ${name} — destination already exists: ${dest}`);
    return;
  }
  log(`MOVE ${name}: ${src} → ${dest}`);
  if (!DRY_RUN) {
    mkdirSync(dest, { recursive: true });
    renameSync(src, dest);
  }
}

// ─── Main ───────────────────────────────────────────────

async function fixDoubled() {
  // Determine parent root: first positional arg if present, else homedir().
  // This is the directory that CONTAINS the outer .llm-wiki/.
  const positional = process.argv.find(
    (a, i) => i >= 2 && !a.startsWith("--"),
  );
  const parentRoot = positional
    ? positional.startsWith("/")
      ? positional
      : join(process.cwd(), positional)
    : homedir();

  const outer = join(parentRoot, ".llm-wiki");
  const inner = join(outer, ".llm-wiki");
  const innerSentinel = join(inner, "config.json");

  console.log(`\n🔍 Scanning for doubled vault at: ${inner}\n`);

  if (!existsSync(innerSentinel)) {
    console.log("✅ No doubled vault detected (no inner .llm-wiki/config.json).");
    console.log(`   Outer: ${outer}`);
    console.log(`   Inner: ${inner}`);
    console.log("   Nothing to do.");
    process.exit(0);
  }

  const entries = readdirSync(inner);
  const plan = entries.map((entry) => {
    const src = join(inner, entry);
    const dest = join(outer, entry);
    return { src, dest, entry, collision: existsSync(dest) };
  });

  console.log("📋 Flatten plan:");
  console.log(`   ${inner}/  →  ${outer}/`);
  console.log("   ─────────────────────────────");
  for (const p of plan) {
    const status = p.collision ? "⚠️  COLLISION (skip)" : "✓ move";
    console.log(`   ${status}  ${p.entry}`);
  }

  if (plan.every((p) => p.collision)) {
    console.log(
      "\n❌ Every inner entry collides with the outer vault. Resolve manually.",
    );
    process.exit(1);
  }

  if (!FORCE && !DRY_RUN) {
    console.log("\n❓ Proceed with flatten? (y/N)");
    process.stdin.setRawMode?.(false);
    const answer = await new Promise((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()));
    });
    if (answer !== "y" && answer !== "yes") {
      console.log("Migration cancelled.");
      process.exit(0);
    }
  }

  console.log("");
  let moved = 0;
  let skipped = 0;
  for (const p of plan) {
    if (p.collision) {
      log(`SKIP ${p.entry} — destination already exists`);
      skipped++;
      continue;
    }
    log(`MOVE ${p.entry}: ${p.src} → ${p.dest}`);
    if (!DRY_RUN) renameSync(p.src, p.dest);
    moved++;
  }

  if (skipped === 0 && !DRY_RUN) {
    try {
      rmdirSync(inner);
      log(`RMDIR ${inner}`);
    } catch (err) {
      log(`RMDIR ${inner} failed: ${err.message} (left in place)`);
    }
  }

  console.log("");
  if (DRY_RUN) {
    console.log(`✅ Dry-run complete. Would move ${moved}, skip ${skipped}.`);
  } else {
    console.log(`✅ Flatten complete. Moved ${moved}, skipped ${skipped}.`);
    if (skipped > 0) {
      console.log(
        `   ${skipped} entry(ies) left in ${inner} due to collisions. Resolve manually.`,
      );
    }
  }
}

async function main() {
  if (FIX_DOUBLED) {
    await fixDoubled();
    return;
  }

  // Determine root directory
  const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();

  console.log(`\n🔍 Scanning for legacy wiki at: ${root}\n`);

  // Check for old-style vault
  const oldSentinel = join(root, ".wiki", "config.json");
  const newSentinel = join(root, ".llm-wiki", "config.json");

  if (!existsSync(oldSentinel)) {
    console.log("❌ No legacy wiki found (no .wiki/config.json). Nothing to migrate.");
    if (existsSync(newSentinel)) {
      console.log("   ✓ New-format wiki already exists at .llm-wiki/");
    } else {
      console.log("   No wiki vault found. Use wiki_bootstrap to create one.");
    }
    process.exit(0);
  }

  if (existsSync(newSentinel)) {
    console.log(
      "⚠️  Both legacy (.wiki/) and new (.llm-wiki/) vaults detected.\n" +
        "   The new vault already exists. Remove .llm-wiki/ first or specify a different root.",
    );
    process.exit(1);
  }

  // Migration plan
  const moves = [
    {
      src: join(root, ".wiki", "config.json"),
      dest: join(root, ".llm-wiki", "config.json"),
      type: "file",
      name: "config",
    },
    {
      src: join(root, ".wiki", "templates"),
      dest: join(root, ".llm-wiki", "templates"),
      type: "dir",
      name: "templates",
    },
    {
      src: join(root, "raw"),
      dest: join(root, ".llm-wiki", "raw"),
      type: "dir",
      name: "raw sources",
    },
    {
      src: join(root, "wiki"),
      dest: join(root, ".llm-wiki", "wiki"),
      type: "dir",
      name: "wiki pages",
    },
    {
      src: join(root, "meta"),
      dest: join(root, ".llm-wiki", "meta"),
      type: "dir",
      name: "metadata",
    },
    {
      src: join(root, "outputs"),
      dest: join(root, ".llm-wiki", "outputs"),
      type: "dir",
      name: "outputs",
    },
    {
      src: join(root, ".discoveries"),
      dest: join(root, ".llm-wiki", ".discoveries"),
      type: "dir",
      name: "discovery tracking",
    },
  ];

  // Check for WIKI_SCHEMA.md at root
  const oldSchema = join(root, "WIKI_SCHEMA.md");
  const schemas = [];
  if (existsSync(oldSchema)) {
    schemas.push({ src: oldSchema, dest: join(root, ".llm-wiki", "WIKI_SCHEMA.md") });
  }

  // Print plan
  console.log("📋 Migration plan:");
  console.log("   Legacy format → New format");
  console.log("   ─────────────────────────────");
  for (const m of moves) {
    console.log(`   ${existsSync(m.src) ? "✓" : "○"} ${m.name}: ${m.src} → ${m.dest}`);
  }
  for (const s of schemas) {
    console.log(`   ✓ WIKI_SCHEMA: ${s.src} → ${s.dest}`);
  }

  // Remaining .wiki/ dir contents (after config + templates moved)
  const dotWikiContents = readdirSync(join(root, ".wiki")).filter(
    (e) => e !== "config.json" && e !== "templates",
  );
  if (dotWikiContents.length > 0) {
    console.log(
      `\n   ⚠️ Additional .wiki/ contents (${dotWikiContents.length} items) will be left in place.`,
    );
    for (const c of dotWikiContents) {
      console.log(`      .wiki/${c}`);
    }
  }

  // Confirmation
  if (!FORCE && !DRY_RUN) {
    console.log("\n❓ Proceed with migration? (y/N)");
    // Read from stdin
    process.stdin.setRawMode?.(false);
    const answer = await new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        resolve(data.toString().trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      console.log("Migration cancelled.");
      process.exit(0);
    }
  }

  // Execute
  console.log("");
  for (const m of moves) {
    if (m.type === "dir") {
      moveDir(m.src, m.dest, m.name);
    } else {
      moveDir(m.src, m.dest, m.name);
    }
  }

  // Move WIKI_SCHEMA.md
  for (const s of schemas) {
    log(`MOVE WIKI_SCHEMA: ${s.src} → ${s.dest}`);
    if (!DRY_RUN) {
      mkdirSync(join(root, ".llm-wiki"), { recursive: true });
      renameSync(s.src, s.dest);
    }
  }

  // Create forwarding marker in old .wiki/
  if (!DRY_RUN) {
    const forwardingMarker = join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md");
    const newRoot = join(root, ".llm-wiki");
    writeFileSync(
      forwardingMarker,
      [
        "# Migration Complete",
        "",
        `This vault was migrated to the new layout at \`.llm-wiki/\` on ${new Date().toISOString().split("T")[0]}.`,
        "",
        "The old `.wiki/` directory is kept as a forwarding marker.",
        "Remove it once you've verified everything works.",
        "",
        `New location: \`${newRoot}\``,
        "",
      ].join("\n"),
      "utf-8",
    );
    log("CREATE forwarding marker: .wiki/MIGRATED_TO_LLM_WIKI.md");
  }

  console.log("");
  if (DRY_RUN) {
    console.log("✅ Dry-run complete. No changes made.");
    console.log("   Run without --dry-run to perform the migration.");
  } else {
    console.log("✅ Migration complete!");
    console.log("");
    console.log("   What changed:");
    console.log("   • All wiki content moved under .llm-wiki/");
    console.log("   • Raw sources:       .llm-wiki/raw/");
    console.log("   • Wiki pages:        .llm-wiki/wiki/");
    console.log("   • Metadata:          .llm-wiki/meta/");
    console.log("   • Config/templates:  .llm-wiki/ (config.json, templates/)");
    console.log("   • Outputs:           .llm-wiki/outputs/");
    console.log("   • Forwarding marker: .wiki/MIGRATED_TO_LLM_WIKI.md");
    console.log("");
    console.log("   The old .wiki/ dir is kept as a marker. You can remove it once verified.");
    console.log("");
    console.log("   Update your gitignore:");
    console.log("     echo '.llm-wiki/' >> .gitignore");
    console.log("");
  }
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
