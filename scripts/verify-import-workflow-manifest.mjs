import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const generatedRoot = resolve(
  process.cwd(),
  "app",
  ".well-known",
  "workflow",
  "v1",
);
const expectedWorkflows = [
  "executeImportAnalysisWorkflow",
  "executeImportCommitWorkflow",
];

const manifest = JSON.parse(
  await readFile(resolve(generatedRoot, "manifest.json"), "utf8"),
);
const workflowEntries = Object.entries(manifest.workflows ?? {}).flatMap(
  ([sourceFile, entries]) =>
    Object.entries(entries).map(([exportName, metadata]) => ({
      exportName,
      metadata,
      sourceFile,
    })),
);
const flowRoute = await readFile(
  resolve(generatedRoot, "flow", "route.js"),
  "utf8",
);

for (const exportName of expectedWorkflows) {
  const entry = workflowEntries.find(
    candidate => candidate.exportName === exportName,
  );
  if (
    !entry ||
    !entry.sourceFile.includes("importing/workflows/import-assistance") ||
    typeof entry.metadata?.workflowId !== "string" ||
    !entry.metadata.workflowId.endsWith(`//${exportName}`) ||
    !flowRoute.includes(exportName)
  ) {
    throw new Error(
      `Workflow build did not register required import workflow: ${exportName}`,
    );
  }
}

console.log(
  `Verified Workflow manifest (${expectedWorkflows.length} import workflows).`,
);
