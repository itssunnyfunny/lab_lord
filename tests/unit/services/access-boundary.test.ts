import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.name === "generated" ? []
    : e.isDirectory() ? files(join(root, e.name)) : /\.tsx?$/.test(e.name) ? [join(root, e.name)] : []);
}
describe("interactive access boundaries", () => {
  it("keeps route and server-action analytics behind a policy-bearing service", () => {
    const violations: string[] = [];
    for (const file of files("app")) {
      const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
          && node.moduleSpecifier.text.startsWith("@/analytics/")
          && node.moduleSpecifier.text !== "@/analytics/trends/range"
          && !node.importClause?.isTypeOnly) violations.push(file);
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    expect(violations).toEqual([]);
  });
  it("retires the unused unfenced import executor without changing Workflow execution", () => {
    expect(existsSync("importing/services/import-commit.service.ts")).toBe(false);
    expect(existsSync("importing/workflows/import-assistance.ts")).toBe(true);
    for (const file of files("app").concat(files("importing"))) {
      expect(readFileSync(file, "utf8")).not.toMatch(/ImportCommitService|import-commit\.service/);
    }
  });
});
