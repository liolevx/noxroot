import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ZodType } from "zod";
import {
  noxrootConfigSchema,
  routesConfigSchema,
  verificationConfigSchema,
  type NoxrootConfig,
  type RoutesConfig,
  type VerificationConfig,
} from "./schema.js";

export class ConfigurationError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigurationError";
  }
}

async function loadYaml<T>(file: string, schema: ZodType<T>): Promise<T | undefined> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const parsed: unknown = parse(source);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      throw new ConfigurationError(file, details);
    }
    return result.data;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(file, (error as Error).message);
  }
}

export async function loadConfig(root: string): Promise<NoxrootConfig | undefined> {
  return loadYaml(path.join(root, ".noxroot", "config.yml"), noxrootConfigSchema);
}

export async function loadVerification(root: string): Promise<VerificationConfig | undefined> {
  return loadYaml(path.join(root, ".noxroot", "verification.yml"), verificationConfigSchema);
}

export async function loadRoutes(root: string): Promise<RoutesConfig | undefined> {
  return loadYaml(path.join(root, ".noxroot", "routes.yml"), routesConfigSchema);
}
