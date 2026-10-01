import { z } from "zod";
import { AI_MODEL_NAMES, isKnownModel } from "../constructs/ai-models.js";
import {
  APP_NAME_MIN,
  NAME_MAX,
  NAME_PATTERN,
  RESERVED_SECRET_PREFIXES,
  SECRET_PATTERN,
  VERSION_MAX,
  VERSION_PATTERN,
} from "./names.js";

const nameMsg =
  "must be lowercase letters, digits and single hyphens, starting with a letter (e.g. my-app)";

const appName = z
  .string({ error: "must be a string" })
  .min(APP_NAME_MIN, `must be at least ${APP_NAME_MIN} characters`)
  .max(NAME_MAX, `must be at most ${NAME_MAX} characters`)
  .regex(NAME_PATTERN, nameMsg);

const resourceName = z
  .string()
  .min(1)
  .max(NAME_MAX, `must be at most ${NAME_MAX} characters`)
  .regex(NAME_PATTERN, nameMsg);

/** `main:`（null）は `main: {}` と同義。中身を持てるキーは v0 では無い。 */
const emptyBody = z.preprocess(
  (v) => (v === null ? {} : v),
  z.strictObject({}, { error: "resource options are not supported in v0 (use `{}`)" }),
);

const resources = z.record(resourceName, emptyBody);

const runtime = z.strictObject({
  language: z.enum(["python", "typescript"], { error: "must be one of: python, typescript" }),
  version: z
    .string({
      error: (iss) =>
        typeof iss.input === "number"
          ? 'must be a quoted string, e.g. "3.13" (quote it so YAML does not read it as a number)'
          : "must be a string",
    })
    .regex(/^\d+(\.\d+)*$/, 'must look like "3.13"')
    .optional(),
});

export const AUTH_PROVIDERS = ["google", "oidc", "entra", "saml"] as const;

const authObject = z.strictObject({
  provider: z
    .enum(AUTH_PROVIDERS, { error: `must be one of: ${AUTH_PROVIDERS.join(", ")}` })
    .optional(),
});

const http = z.union([
  z.boolean(),
  z.strictObject({ auth: z.union([z.boolean(), authObject]).optional() }),
]);

const secrets = z
  .array(
    z
      .string()
      .regex(
        SECRET_PATTERN,
        "must be an environment variable name (A-Z, 0-9, _; starting with a letter)",
      )
      .refine((s) => !RESERVED_SECRET_PREFIXES.some((p) => s.startsWith(p)), {
        error: `must not start with a reserved prefix (${RESERVED_SECRET_PREFIXES.join(", ")})`,
      }),
  )
  .refine((a) => new Set(a).size === a.length, { error: "must not contain duplicates" });

const ai = z.strictObject({
  models: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]*$/, "must be a logical model name such as sonnet or nova-micro")
        .refine(isKnownModel, {
          error: (iss) =>
            `unknown AI model ${JSON.stringify(iss.input)} (known: ${AI_MODEL_NAMES.join(", ")})`,
        }),
    )
    .refine((a) => new Set(a).size === a.length, { error: "must not contain duplicates" }),
});

const versionRule = z
  .string()
  .max(VERSION_MAX)
  .refine((v) => v === "branch" || VERSION_PATTERN.test(v), {
    error: 'must be "branch" or a lowercase version name such as "stable"',
  });

const git = z.strictObject({
  production: z
    .strictObject({
      branch: z.string().min(1, "must not be empty"),
      version: versionRule.optional(),
    })
    .optional(),
  preview: z.strictObject({ branch: z.string().min(1, "must not be empty") }).optional(),
  pullRequests: z.boolean().optional(),
});

export const configSchema = z.strictObject({
  version: z.literal(1, { error: "must be 1" }),
  name: appName,
  runtime,
  http: http.optional(),
  database: resources.optional(),
  storage: resources.optional(),
  ai: ai.optional(),
  secrets: secrets.optional(),
  git: git.optional(),
});

export type FlareonConfig = z.infer<typeof configSchema>;
