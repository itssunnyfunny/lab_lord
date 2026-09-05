import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const methods = new Set(["createSubscription", "updateSubscription", "cancelSubscription", "cancelScheduledChanges"]);
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.name === "generated" ? []
    : e.isDirectory() ? files(join(root,e.name)) : /\.tsx?$/.test(e.name) ? [join(root,e.name).replaceAll("\\","/")] : []);
}
function violations(file: string, source: string) {
  if (["lib/razorpay.ts", "services/billingProviderAction.service.ts"].includes(file)) return [];
  const errors: string[] = [];
  // These are application APIs with similarly named methods, not provider clients.
  const serviceReceiver = file === "lib/whatsappReportRoute.ts" ? "WhatsAppReportService"
    : file === "app/org/[orgId]/settings/page.tsx" ? "billing" : "";
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === "getRazorpayMutationClient") errors.push(`${file}: mutation adapter import/use`);
    if (ts.isPropertyAccessExpression(node) && methods.has(node.name.text)
      && !["this", "BillingService", serviceReceiver].includes(node.expression.getText(ast))) errors.push(`${file}: ${node.name.text}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && methods.has(node.argumentExpression.text)) errors.push(`${file}: computed mutation access`);
    if (ts.isBindingElement(node) && methods.has((node.propertyName ?? node.name).getText(ast))) errors.push(`${file}: extracted mutation`);
    if (ts.isStringLiteralLike(node) && /api\.razorpay\.com/.test(node.text)
      && !(file === "scripts/razorpay-preflight.ts" && node.text === "https://api.razorpay.com/v1/methods")) errors.push(`${file}: provider transport bypass`);
    ts.forEachChild(node,visit);
  }
  visit(ast); return errors;
}
describe("SaaS billing dispatch boundary", () => {
  it("keeps every provider subscription mutation inside the executor and adapter", () => {
    expect(["services", "lib", "app", "importing", "scripts"].flatMap(files)
      .flatMap(f => violations(f,readFileSync(f,"utf8")))).toEqual([]);
  });
  it("rejects aliases, extracted methods, computed access and direct transport", () => {
    for (const source of [
      'import { getRazorpayMutationClient as unsafe } from "@/lib/razorpay";',
      'client.cancelSubscription("id", {});', 'const { createSubscription: create } = client;',
      'client["updateSubscription"]("id", {});', 'fetch("https://api.razorpay.com/v1/subscriptions");',
    ]) expect(violations("services/unsafe.ts",source).length).toBeGreaterThan(0);
  });
});
