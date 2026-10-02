import { z } from "zod";
import { AI_MODEL_NAMES, isKnownModel } from "../constructs/ai-models.js";
import {
  APP_NAME_MIN,
  NAME_MAX,
  idpSecretNames,
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
/** v0 で実装済みの外部 IdP。saml は名前だけ予約し、明示的なエラーにする。 */
export const SUPPORTED_AUTH_PROVIDERS = ["google", "oidc", "entra"] as const;

/** Cognito の IdP 名として使えない（既存プロバイダと衝突する）名前。 */
const RESERVED_IDP_NAMES = ["cognito", "google", "facebook", "loginwithamazon", "signinwithapple"];

/** Entra のテナント ID（GUID）。issuer はテナント ID 形式でないと Cognito の issuer 照合に失敗する。 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** マルチテナント・個人アカウント用の特別なテナント（Microsoft アカウントのテナント ID を含む）。 */
const MULTI_TENANTS = [
  "common",
  "organizations",
  "consumers",
  "9188040d-6c67-4c5b-b112-36a304b66dad",
];

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
/** allow は front Lambda の環境変数（合計 4KB 上限）で渡すので、カンマ区切りの合計長を制限する。 */
export const ALLOW_MAX_CHARS = 2000;

const allow = z
  .strictObject({
    domains: z
      .array(
        z.string().regex(DOMAIN, "must be a domain name such as example.com (no @ or wildcards)"),
      )
      .optional(),
    emails: z.array(z.string().regex(EMAIL, "must be an email address")).optional(),
  })
  .superRefine((a, ctx) => {
    const all = [...(a.domains ?? []), ...(a.emails ?? [])];
    if (!all.length) {
      ctx.addIssue({
        code: "custom",
        message:
          "must list at least one domain or email (omit allow to let everyone the sign-in method accepts in)",
      });
    } else if (all.join(",").length > ALLOW_MAX_CHARS) {
      ctx.addIssue({
        code: "custom",
        message: `is too long (at most ${ALLOW_MAX_CHARS} characters in total); prefer domains over individual emails`,
      });
    }
  });

const authObject = z
  .strictObject({
    provider: z
      .enum(AUTH_PROVIDERS, { error: `must be one of: ${AUTH_PROVIDERS.join(", ")}` })
      .optional(),
    /** OIDC の issuer URL（discovery に使う）。非秘密値なので YAML に置ける。 */
    issuer: z.string({ error: "must be a string" }).optional(),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, "must be an OAuth scope"))
      .min(1, "must not be empty")
      .optional(),
    /** Managed Login のボタン表示名（Cognito の IdP 名）。 */
    name: z.string({ error: "must be a string" }).optional(),
    /** Entra ID のディレクトリ（テナント）ID。 */
    tenant: z.string({ error: "must be a string" }).optional(),
    /** IdP で認証できた人のうち、アプリに入れる人（未指定なら全員）。 */
    allow: allow.optional(),
  })
  .superRefine((a, ctx) => {
    const p = a.provider;
    if (p === "saml") {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: `"${p}" is not supported in v0 (supported: ${SUPPORTED_AUTH_PROVIDERS.join(", ")})`,
      });
      return;
    }
    if (p !== "entra" && a.tenant !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["tenant"],
        message: "only applies to provider: entra",
      });
    }
    if (p !== "oidc") {
      for (const k of ["issuer", "scopes", "name"] as const) {
        if (a[k] !== undefined) {
          ctx.addIssue({ code: "custom", path: [k], message: "only applies to provider: oidc" });
        }
      }
    }
    if (p === "entra") {
      const t = a.tenant;
      if (t === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tenant"],
          message:
            "is required for provider: entra (the Directory (tenant) ID of your Entra tenant)",
        });
      } else if (MULTI_TENANTS.includes(t.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["tenant"],
          message:
            "must be your own tenant: multi-tenant (common, organizations) and personal-account (consumers) sign-in are not supported; Flarelet uses single-tenant sign-in",
        });
      } else if (!GUID.test(t)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenant"],
          message:
            "must be the Directory (tenant) ID (a GUID such as 72f988bf-86f1-41af-91ab-2d7cd011db47), not a domain name; Entra issues tokens with the tenant ID, so a domain would not match",
        });
      }
    }
    if (p !== "oidc") return;
    if (a.issuer === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "is required for provider: oidc (the OpenID Connect issuer URL)",
      });
    } else if (!isHttpsUrl(a.issuer)) {
      ctx.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "must be an https URL such as https://idp.example.com",
      });
    }
    if (a.scopes && !a.scopes.includes("openid")) {
      ctx.addIssue({ code: "custom", path: ["scopes"], message: 'must include "openid"' });
    }
    if (
      a.name !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(a.name) ||
        RESERVED_IDP_NAMES.includes(a.name.toLowerCase()))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message:
          "must be 1-32 letters, digits, spaces, '.', '_' or '-' and not a built-in provider name (Google, Cognito, ...)",
      });
    }
  });

function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

/** API Gateway のアカウント既定クォータ（rate 10000 req/s、burst 5000）を上限にする。 */
const THROTTLE_MAX_RATE = 10000;
const THROTTLE_MAX_BURST = 5000;

const throttleObject = z.strictObject({
  rate: z.number().positive("must be a positive number").max(THROTTLE_MAX_RATE),
  burst: z
    .number()
    .int("must be an integer")
    .positive("must be a positive integer")
    .max(THROTTLE_MAX_BURST),
});

const http = z.union([
  z.boolean(),
  z.strictObject({
    auth: z.union([z.boolean(), authObject]).optional(),
    // false で無効化。省略時は lifecycle ごとの既定値（constructs）
    throttle: z.union([z.literal(false), throttleObject]).optional(),
  }),
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

/** 既存の標準 SNS トピック（FIFO は CloudWatch アラームの宛先にできない）。Flarelet はトピックを作らない。 */
const SNS_TOPIC_ARN = /^arn:aws:sns:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;

const alerts = z.strictObject({
  topicArn: z
    .string()
    .regex(SNS_TOPIC_ARN, "must be an SNS topic ARN such as arn:aws:sns:<region>:<account>:<name>"),
});

const configObject = z.strictObject({
  version: z.literal(1, { error: "must be 1" }),
  name: appName,
  runtime,
  http: http.optional(),
  database: resources.optional(),
  storage: resources.optional(),
  ai: ai.optional(),
  secrets: secrets.optional(),
  git: git.optional(),
  alerts: alerts.optional(),
});

/** 外部 IdP の資格情報名は Flarelet が管理する（アプリには渡さない）ので `secrets:` に宣言させない。 */
export const configSchema = configObject.superRefine((c, ctx) => {
  const auth = typeof c.http === "object" ? c.http.auth : undefined;
  const provider = typeof auth === "object" ? auth.provider : undefined;
  if (provider !== "google" && provider !== "oidc" && provider !== "entra") return;
  const reserved = idpSecretNames(provider);
  for (const s of c.secrets ?? []) {
    if (reserved.includes(s)) {
      ctx.addIssue({
        code: "custom",
        path: ["secrets"],
        message: `${s} is managed by http.auth.provider: ${provider}; remove it from secrets (set it with \`flarelet secret set ${s}\`)`,
      });
    }
  }
});

export type FlareletConfig = z.infer<typeof configSchema>;
