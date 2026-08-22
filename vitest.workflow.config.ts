import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  root: "tests/workflow",
  plugins: [
    tsconfigPaths(),
    ...workflow({
      rootDir: "../../.next/cache/workflow-tests",
    }),
  ],
  test: {
    environment: "node",
    include: ["**/*.workflow.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
