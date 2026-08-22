import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type WorkflowDiscovery = {
    discoveredSteps: Set<string>;
    discoveredWorkflows: Set<string>;
};

type WorkflowBuilder = {
    discoverEntries(
        inputFiles: string[],
        outputDirectory: string,
        tsconfigPath: string
    ): Promise<WorkflowDiscovery>;
    getInputFiles(): Promise<string[]>;
};

type WorkflowBuilderConstructor = new (
    config: Record<string, unknown>
) => WorkflowBuilder;

type WorkflowBuilderModule = {
    getNextBuilder(nextVersion: string): Promise<WorkflowBuilderConstructor>;
};

describe("Import Workflow registration", () => {
    it("is discoverable from Next.js route entrypoints", async () => {
        const require = createRequire(import.meta.url);
        const workflowNextShim = require.resolve("workflow/next");
        const workflowNextIntegration = createRequire(workflowNextShim).resolve(
            "@workflow/next"
        );
        const builderModulePath = resolve(
            dirname(workflowNextIntegration),
            "builder.js"
        );
        const { getNextBuilder } = await import(
            pathToFileURL(builderModulePath).href
        ) as WorkflowBuilderModule;
        const NextBuilder = await getNextBuilder(
            require("next/package.json").version
        );
        const projectRoot = process.cwd();
        const builder = new NextBuilder({
            buildTarget: "next",
            dirs: ["."],
            distDir: ".next",
            externalPackages: ["server-only", "client-only"],
            moduleSpecifierRoot: projectRoot,
            pageExtensions: ["tsx", "ts", "jsx", "js"],
            projectRoot,
            stepsBundlePath: "",
            webhookBundlePath: "",
            watch: false,
            workflowsBundlePath: "",
            workingDir: projectRoot,
        });
        const inputFiles = await builder.getInputFiles();
        const discovered = await builder.discoverEntries(
            inputFiles,
            projectRoot,
            resolve(projectRoot, "tsconfig.json")
        );

        expect([...discovered.discoveredWorkflows]).toEqual([
            expect.stringMatching(
                /\/importing\/workflows\/import-assistance\.ts$/
            ),
        ]);
    });
});
