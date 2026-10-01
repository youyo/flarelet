import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".flareon", "test/e2e/aws/fixtures"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
