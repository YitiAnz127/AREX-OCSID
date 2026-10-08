import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "packages", "coding-agent", "src");
const distRoot = join(packageRoot, "dist");

async function copyDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    // Verification caches are not runtime assets and may hold Windows locks.
    filter: (path) => ![".pytest_cache", "__pycache__"].includes(basename(path)) && !path.endsWith(".pyc"),
  });
}

async function copyFiles(sourceDirectory, destinationDirectory, predicate) {
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) {
      await cp(join(sourceDirectory, entry.name), join(destinationDirectory, entry.name));
    }
  }
}

await copyFiles(
  join(sourceRoot, "modes", "interactive", "theme"),
  join(distRoot, "modes", "interactive", "theme"),
  (name) => name.endsWith(".json"),
);

await copyFiles(
  join(sourceRoot, "modes", "interactive", "assets"),
  join(distRoot, "modes", "interactive", "assets"),
  (name) => name.endsWith(".png"),
);

await copyFiles(
  join(sourceRoot, "core", "export-html"),
  join(distRoot, "core", "export-html"),
  (name) => name === "template.html" || name === "template.css" || name === "template.js",
);

await copyDirectory(
  join(sourceRoot, "core", "export-html", "vendor"),
  join(distRoot, "core", "export-html", "vendor"),
);

const ocsidSkills = join(sourceRoot, "ocsid", "skills");
try {
  await rm(join(distRoot, "ocsid-resources"), { recursive: true, force: true });
  await copyDirectory(ocsidSkills, join(distRoot, "ocsid-resources", "skills"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
