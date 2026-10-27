import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const releaseDir = resolve(repoRoot, "release");
const stagingRoot = resolve(releaseDir, "staging");

const readJson = async (relativePath) => JSON.parse(await readFile(resolve(repoRoot, relativePath), "utf8"));

const requirePath = async (path, description) => {
  try {
    await stat(path);
  } catch {
    throw new Error(`${description} is missing: ${path}`);
  }
};

const rootPackage = await readJson("package.json");
const serverPackage = await readJson("apps/server/package.json");
const lockfile = parse(await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8"));

const releaseVersion = process.env.MDCZ_RELEASE_VERSION?.trim() || rootPackage.version;

const stagingDirName = `mdcz-${releaseVersion}`;
const stagingDir = resolve(stagingRoot, stagingDirName);
const serverDist = resolve(repoRoot, "apps/server/dist");

await requirePath(resolve(serverDist, "server.js"), "Server bundle");
await requirePath(resolve(serverDist, "web/index.html"), "WebUI bundle");
await requirePath(resolve(serverDist, "persistence/drizzle"), "Drizzle migrations");
await requirePath(resolve(serverDist, "resources/mapping_table"), "Translation mappings");

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

await cp(resolve(serverDist, "server.js"), resolve(stagingDir, "server.js"));
await cp(resolve(serverDist, "resources/watermark"), resolve(stagingDir, "resources/watermark"), { recursive: true });
await cp(resolve(serverDist, "web"), resolve(stagingDir, "web"), { recursive: true });
await cp(resolve(serverDist, "persistence/drizzle"), resolve(stagingDir, "persistence/drizzle"), { recursive: true });
await cp(resolve(serverDist, "resources/mapping_table"), resolve(stagingDir, "resources/mapping_table"), {
  recursive: true,
});
await cp(resolve(repoRoot, "apps/server/.env.example"), resolve(stagingDir, ".env.example"));

const releasePackage = {
  name: "mdcz",
  version: releaseVersion,
  private: true,
  type: "module",
  packageManager: rootPackage.packageManager,
  scripts: {
    start: "node server.js",
  },
  dependencies: Object.fromEntries(
    Object.entries(serverPackage.dependencies).filter(([, version]) => !version.startsWith("workspace:")),
  ),
  engines: {
    node: ">=24",
  },
  pnpm: {
    onlyBuiltDependencies: ["better-sqlite3", "impit"],
    ignoredBuiltDependencies: ["sharp"],
  },
};

await writeFile(resolve(stagingDir, "package.json"), `${JSON.stringify(releasePackage, null, 2)}\n`);
const lockedDependencies = {};
for (const [name, specifier] of Object.entries(releasePackage.dependencies)) {
  const locked = lockfile.importers["apps/server"].dependencies[name];
  if (!locked || locked.specifier !== specifier) throw new Error(`Runtime dependency is not locked: ${name}`);
  lockedDependencies[name] = locked;
}
lockfile.importers = { ".": { dependencies: lockedDependencies } };
delete lockfile.catalogs;
await writeFile(resolve(stagingDir, "pnpm-lock.yaml"), stringify(lockfile));

console.log(`Staged ${stagingDir}`);
