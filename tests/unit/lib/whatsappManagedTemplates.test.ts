import { describe, expect, it } from "vitest";

import {
  getManagedWhatsAppTemplate,
  hashWhatsAppTemplateComponents,
  listManagedWhatsAppTemplates,
  prepareManagedWhatsAppTemplate,
  resolveExactManagedWhatsAppTemplateDefinition,
  WHATSAPP_MANAGED_STOP_PAYLOAD,
  WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
  WHATSAPP_MANAGED_TEMPLATE_KEYS,
  WHATSAPP_MANAGED_TEMPLATE_LANGUAGES,
  WhatsAppManagedTemplateError,
  type WhatsAppManagedTemplateDefinition,
} from "@/lib/whatsappManagedTemplates";

describe("managed WhatsApp utility-template catalogue", () => {
  it("contains every versioned key in only the two officially supported product languages", () => {
    const definitions = listManagedWhatsAppTemplates();

    expect(definitions).toHaveLength(
      WHATSAPP_MANAGED_TEMPLATE_KEYS.length * WHATSAPP_MANAGED_TEMPLATE_LANGUAGES.length
    );
    expect(new Set(definitions.map(item => `${item.providerTemplateName}:${item.language}`)).size)
      .toBe(definitions.length);
    expect(new Set(definitions.map(item => item.language))).toEqual(new Set(["en_IN", "hi"]));
    expect(definitions.map(item => item.language)).not.toContain("hinglish");
    expect(definitions.map(item => item.language)).not.toContain("hi_IN");

    for (const definition of definitions) {
      expect(definition.catalogVersion).toBe(WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION);
      expect(definition.providerTemplateName).toMatch(/^lablords_[a-z0-9_]+_v1$/);
      expect(definition.category).toBe("UTILITY");
      expect(definition.parameterFormat).toBe("POSITIONAL");
      expect(definition.stopPayload).toBe(WHATSAPP_MANAGED_STOP_PAYLOAD);
      expect(definition.catalogHash).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.components)).toBe(true);
      expect(definition.components).toEqual([
        expect.objectContaining({ type: "BODY", example: { body_text: [expect.any(Array)] } }),
        expect.objectContaining({ type: "FOOTER" }),
        expect.objectContaining({
          type: "BUTTONS",
          buttons: [expect.objectContaining({ type: "QUICK_REPLY" })],
        }),
      ]);
    }
  });

  it("keeps catalogue and component hashes deterministic", () => {
    const first = getManagedWhatsAppTemplate("FEE_RENEWAL_POLITE", "en_IN");
    const second = getManagedWhatsAppTemplate("FEE_RENEWAL_POLITE", "en_IN");

    expect(second).toBe(first);
    expect(second.catalogHash).toBe(first.catalogHash);
    expect(hashWhatsAppTemplateComponents(second.components)).toBe(
      hashWhatsAppTemplateComponents(JSON.parse(JSON.stringify(first.components)))
    );
  });

  it("keeps grouped collection reminders factual during a payment race in both languages", () => {
    const english = getManagedWhatsAppTemplate("MULTI_STUDENT_COLLECTION_SUMMARY", "en_IN");
    const hindi = getManagedWhatsAppTemplate("MULTI_STUDENT_COLLECTION_SUMMARY", "hi");
    const englishBody = english.components.find(component => component.type === "BODY");
    const hindiBody = hindi.components.find(component => component.type === "BODY");

    expect(englishBody).toMatchObject({
      text: expect.stringContaining("ignore this reminder if payment has already been recorded"),
    });
    expect(hindiBody).toMatchObject({
      text: expect.stringContaining("यदि भुगतान दर्ज हो चुका है तो इस संदेश को अनदेखा करें"),
    });
  });

  it("orders, normalizes, bounds, and deterministically renders trusted variables", () => {
    const definition = getManagedWhatsAppTemplate("FEE_RENEWAL_POLITE", "en_IN");
    const prepared = prepareManagedWhatsAppTemplate(definition, {
      studentName: "  Sample   Student  ",
      amount: "1,200",
      branchName: "Sample Branch",
      dueDate: "30 Aug 2026",
    });

    expect(definition.variables.map(variable => variable.key)).toEqual([
      "studentName",
      "amount",
      "branchName",
      "dueDate",
    ]);
    expect(prepared.orderedValues).toEqual([
      "Sample Student",
      "1,200",
      "Sample Branch",
      "30 Aug 2026",
    ]);
    expect(prepared.renderedPreview).toContain(
      "Hi Sample Student, your fee of ₹1,200 for Sample Branch is due on 30 Aug 2026."
    );
    expect(prepared.renderedPreview).not.toMatch(/\{\{[0-9]+\}\}/);
  });

  it.each([
    ["missing variable", {
      studentName: "Sample Student",
      amount: "1,200",
      branchName: "Sample Branch",
    }],
    ["extra variable", {
      studentName: "Sample Student",
      amount: "1,200",
      branchName: "Sample Branch",
      dueDate: "30 Aug 2026",
      arbitrary: "not allowed",
    }],
    ["object injection", {
      studentName: { text: "Sample Student" },
      amount: "1,200",
      branchName: "Sample Branch",
      dueDate: "30 Aug 2026",
    }],
    ["control characters", {
      studentName: "Sample\nStudent",
      amount: "1,200",
      branchName: "Sample Branch",
      dueDate: "30 Aug 2026",
    }],
    ["URL injection", {
      studentName: "Sample Student",
      amount: "1,200",
      branchName: "https://example.test",
      dueDate: "30 Aug 2026",
    }],
    ["invalid money", {
      studentName: "Sample Student",
      amount: "free",
      branchName: "Sample Branch",
      dueDate: "30 Aug 2026",
    }],
  ])("rejects %s", (_label, values) => {
    expect(() => prepareManagedWhatsAppTemplate(
      getManagedWhatsAppTemplate("FEE_RENEWAL_POLITE", "en_IN"),
      values
    )).toThrow(WhatsAppManagedTemplateError);
  });

  it("rejects unsupported catalogue identities and structurally mutated definitions", () => {
    expect(() => getManagedWhatsAppTemplate(
      "UNKNOWN" as never,
      "en_IN"
    )).toThrow(WhatsAppManagedTemplateError);
    expect(() => getManagedWhatsAppTemplate(
      "WELCOME_GENERAL",
      "hinglish" as never
    )).toThrow(WhatsAppManagedTemplateError);
    expect(() => getManagedWhatsAppTemplate(
      "WELCOME_GENERAL",
      "en_IN",
      2
    )).toThrow(WhatsAppManagedTemplateError);

    const definition = getManagedWhatsAppTemplate("WELCOME_GENERAL", "en_IN");
    const mutated = {
      ...definition,
      components: definition.components.map(component =>
        component.type === "BODY" ? { ...component, text: "Arbitrary body" } : component
      ),
    } as WhatsAppManagedTemplateDefinition;
    expect(() => resolveExactManagedWhatsAppTemplateDefinition(mutated))
      .toThrow(WhatsAppManagedTemplateError);
  });
});
