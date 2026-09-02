import { z } from "zod";

const autonomyLevel = z.number().int().min(0).max(5);

const commandAdapterSchema = z.object({
  type: z.literal("command"),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
  healthCheck: z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string()).default([]),
      timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    })
    .optional(),
});

const manualAdapterSchema = z.object({
  type: z.literal("manual"),
});

export const noxrootConfigSchema = z.object({
  version: z.literal(1),
  modules: z
    .array(
      z.enum([
        "repository-profile",
        "agent-routing",
        "project-knowledge",
        "verification",
        "product-ux",
        "orchestration",
        "learning",
        "browser-qa",
      ]),
    )
    .default(["repository-profile", "agent-routing"]),
  roots: z.array(z.string()).min(1).default(["."]),
  entrypoints: z
    .array(z.enum(["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]))
    .default(["AGENTS.md"]),
  context: z
    .object({
      budgetBytes: z.number().int().positive().max(1_000_000).default(16_000),
      documentWarningBytes: z.number().int().positive().default(24_000),
    })
    .default({ budgetBytes: 16_000, documentWarningBytes: 24_000 }),
  autonomy: z
    .object({
      default: autonomyLevel.default(0),
      implementation: autonomyLevel.default(2),
      review: autonomyLevel.default(3),
      merge: autonomyLevel.max(3).default(0),
      delivery: autonomyLevel.max(3).default(0),
    })
    .default({ default: 0, implementation: 2, review: 3, merge: 0, delivery: 0 }),
  agents: z
    .object({
      default: z.string().default("manual"),
      adapters: z
        .record(
          z.string(),
          z.discriminatedUnion("type", [manualAdapterSchema, commandAdapterSchema]),
        )
        .default({ manual: { type: "manual" } }),
    })
    .default({ default: "manual", adapters: { manual: { type: "manual" } } }),
  budgets: z
    .object({
      workerCalls: z.number().int().min(0).max(3).default(2),
      reviewerCalls: z.number().int().min(0).max(3).default(2),
      repairIterations: z.number().int().min(0).max(2).default(1),
      outputBytes: z.number().int().positive().max(1_000_000).default(65_536),
    })
    .default({ workerCalls: 2, reviewerCalls: 2, repairIterations: 1, outputBytes: 65_536 }),
  sensitivePaths: z.array(z.string()).default([]),
  retention: z
    .object({
      evidenceDays: z.number().int().min(1).max(365).default(30),
      maximumRuns: z.number().int().min(1).max(1000).default(100),
    })
    .default({ evidenceDays: 30, maximumRuns: 100 }),
  browser: z
    .object({
      verificationCommandId: z.string().min(1),
      baseUrl: z.url().optional(),
      viewports: z
        .array(
          z.object({
            name: z.string().min(1),
            width: z.number().int().min(240).max(7680),
            height: z.number().int().min(240).max(7680),
          }),
        )
        .max(10)
        .default([]),
    })
    .optional(),
});

export const verificationConfigSchema = z.object({
  version: z.literal(1),
  commands: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        executable: z.string().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
        appliesTo: z.array(z.string()).default(["**/*"]),
      }),
    )
    .default([]),
});

export const routesConfigSchema = z.object({
  version: z.literal(1),
  routes: z.array(
    z.object({
      id: z.string(),
      match: z.array(z.string()),
      include: z.array(z.string()),
      exclude: z.array(z.string()).default([]),
    }),
  ),
});

export type NoxrootConfig = z.infer<typeof noxrootConfigSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type RoutesConfig = z.infer<typeof routesConfigSchema>;
