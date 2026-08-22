import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globalSetup: "./tests/setup/global.ts",
    setupFiles: [],
    // Workflow fixtures require the dedicated @workflow/vitest transform and
    // are run through `pnpm test:workflow`, not the general Vitest suite.
    exclude: [...configDefaults.exclude, "tests/browser/**", "tests/workflow/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["services/**/*.ts", "utils/**/*.ts"],
      exclude: ["**/*.test.ts", "tests/**"],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
    // Run tests sequentially to avoid DB collision
    fileParallelism: false,
    testTimeout: 15000,
  },
});
