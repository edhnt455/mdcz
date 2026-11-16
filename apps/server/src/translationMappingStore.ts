import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileTranslationMappingStore } from "@mdcz/runtime/translate";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const resolveServerBundledMappingDirectory = (): string => {
  const candidates = [
    path.join(moduleDirectory, "resources", "mapping_table"),
    path.resolve(moduleDirectory, "../resources/mapping_table"),
    path.resolve(process.cwd(), "resources", "mapping_table"),
    path.resolve(moduleDirectory, "../../../packages/runtime/resources/mapping_table"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

export const createServerTranslationMappingStore = (): FileTranslationMappingStore =>
  new FileTranslationMappingStore(resolveServerBundledMappingDirectory());
