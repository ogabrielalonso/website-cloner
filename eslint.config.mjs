// Lint rules for the scaffold: Next.js core web vitals plus its TypeScript preset.
import { defineConfig, globalIgnores } from "eslint/config";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default defineConfig([
  ...coreWebVitals,
  ...typescript,
  // Build output and generated types are never linted.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
