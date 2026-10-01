import type { RuntimeLanguage } from "../ir/index.js";

export interface GeneratedFile {
  content: string;
  mode: number;
}

/** Lambda のハンドラ名。Lambda Web Adapter がこの実行ファイルを起動コマンドとして exec する。 */
export const LAUNCHER_HANDLER = "flareon-launcher.sh";

const SECRETS_FILTER = String.raw`[A-Z][A-Z0-9_]*`;

const pythonSecrets = `import os
import re
import shlex

import boto3


def main():
    path = os.environ["FLAREON_SECRETS_PATH"].rstrip("/") + "/"
    client = boto3.client("ssm")
    token = None
    while True:
        kw = {"Path": path, "WithDecryption": True, "Recursive": False}
        if token:
            kw["NextToken"] = token
        res = client.get_parameters_by_path(**kw)
        for p in res.get("Parameters", []):
            name = p["Name"][len(path):]
            if re.fullmatch(r"${SECRETS_FILTER}", name) and not name.startswith(("FLAREON_", "AWS_")):
                print("export %s=%s" % (name, shlex.quote(p["Value"])))
        token = res.get("NextToken")
        if not token:
            break


main()
`;

const nodeSecrets = `"use strict";
// Flareon 生成: SSM のシークレットを環境変数 export 文として標準出力に書く。ランチャーが eval する。
const NAME = /^${SECRETS_FILTER}$/;

function quote(v) {
  return "'" + String(v).replace(/'/g, "'\\\\''") + "'";
}

function formatExports(path, params) {
  let out = "";
  for (const p of params) {
    const name = p.Name.slice(path.length);
    if (!NAME.test(name) || name.startsWith("FLAREON_") || name.startsWith("AWS_")) continue;
    out += "export " + name + "=" + quote(p.Value) + "\\n";
  }
  return out;
}

async function main() {
  const { SSMClient, GetParametersByPathCommand } = require("@aws-sdk/client-ssm");
  const path = process.env.FLAREON_SECRETS_PATH.replace(/\\/+$/, "") + "/";
  const client = new SSMClient({});
  let token;
  let out = "";
  do {
    const res = await client.send(
      new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken: token }),
    );
    out += formatExports(path, res.Parameters || []);
    token = res.NextToken;
  } while (token);
  process.stdout.write(out);
}

module.exports = { formatExports };
if (require.main === module) {
  main().catch((e) => {
    console.error("flareon: failed to load secrets: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
`;

function shell(helper: string, interpreter: string, start: string): string {
  return `#!/bin/sh
# Flareon 生成ランチャー（Lambda Web Adapter の起動コマンド）
set -e
cd "$LAMBDA_TASK_ROOT"
if [ -n "$FLAREON_SECRETS_PATH" ]; then
  secrets="$(${interpreter} "$LAMBDA_TASK_ROOT/${helper}")"
  eval "$secrets"
fi
exec ${start}
`;
}

export function launcherFiles(language: RuntimeLanguage): Record<string, GeneratedFile> {
  if (language === "python") {
    return {
      [LAUNCHER_HANDLER]: {
        content: shell(
          "flareon-secrets.py",
          "python3",
          'python3 -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8080}"',
        ),
        mode: 0o755,
      },
      "flareon-secrets.py": { content: pythonSecrets, mode: 0o644 },
    };
  }
  return {
    [LAUNCHER_HANDLER]: {
      content: shell("flareon-secrets.cjs", "node", 'node "$LAMBDA_TASK_ROOT/index.mjs"'),
      mode: 0o755,
    },
    "flareon-secrets.cjs": { content: nodeSecrets, mode: 0o644 },
  };
}
