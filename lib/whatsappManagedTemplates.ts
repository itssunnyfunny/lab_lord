import { createHash } from "node:crypto";

import type { MetaMessageTemplate } from "@/types/whatsapp";

export const WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION = 1 as const;
export const WHATSAPP_MANAGED_TEMPLATE_LANGUAGES = ["en_IN", "hi"] as const;
export const WHATSAPP_MANAGED_TEMPLATE_KEYS = [
  "WELCOME_GENERAL",
  "WELCOME_ALLOCATED",
  "FEE_RENEWAL_POLITE",
  "FEE_RENEWAL_FRIENDLY",
  "PAST_DUE_POLITE",
  "PAST_DUE_FIRM",
  "MULTI_STUDENT_COLLECTION_SUMMARY",
  "PAYMENT_CONFIRMATION",
  "PAYMENT_CORRECTION",
] as const;

export const WHATSAPP_MANAGED_STOP_LABEL = "Stop updates" as const;
export const WHATSAPP_MANAGED_STOP_LABELS = ["Stop updates", "अपडेट रोकें"] as const;
export const WHATSAPP_MANAGED_STOP_PAYLOAD = "LABLORDS_STOP_UPDATES" as const;

export type WhatsAppManagedTemplateLanguage =
  typeof WHATSAPP_MANAGED_TEMPLATE_LANGUAGES[number];
export type WhatsAppManagedTemplateKey = typeof WHATSAPP_MANAGED_TEMPLATE_KEYS[number];
export type WhatsAppManagedTemplateVariableKey =
  | "studentName"
  | "branchName"
  | "startDate"
  | "seatLabel"
  | "shiftName"
  | "amount"
  | "dueDate"
  | "oldestDueDate"
  | "studentCount"
  | "earliestDueDate"
  | "paymentDate"
  | "paymentMethod"
  | "newStatus";

export type WhatsAppManagedTemplateVariable = Readonly<{
  key: WhatsAppManagedTemplateVariableKey;
  maxLength: number;
  example: string;
}>;

export type WhatsAppManagedTemplateComponent =
  | Readonly<{
      type: "BODY";
      text: string;
      example: Readonly<{ body_text: readonly [readonly string[]] }>;
    }>
  | Readonly<{ type: "FOOTER"; text: string }>
  | Readonly<{
      type: "BUTTONS";
      buttons: readonly [Readonly<{ type: "QUICK_REPLY"; text: string }>];
    }>;

export type WhatsAppManagedTemplateDefinition = Readonly<{
  managedKey: WhatsAppManagedTemplateKey;
  catalogVersion: typeof WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION;
  catalogHash: string;
  providerTemplateName: string;
  language: WhatsAppManagedTemplateLanguage;
  category: "UTILITY";
  parameterFormat: "POSITIONAL";
  variables: readonly WhatsAppManagedTemplateVariable[];
  components: readonly WhatsAppManagedTemplateComponent[];
  stopPayload: typeof WHATSAPP_MANAGED_STOP_PAYLOAD;
}>;

export type PreparedManagedWhatsAppTemplate = Readonly<{
  definition: WhatsAppManagedTemplateDefinition;
  orderedValues: readonly string[];
  renderedPreview: string;
}>;

export class WhatsAppManagedTemplateError extends Error {
  readonly code = "WHATSAPP_MANAGED_TEMPLATE_INVALID";

  constructor(message = "Managed WhatsApp template input is invalid") {
    super(message);
    this.name = "WhatsAppManagedTemplateError";
  }
}

type TemplateCopy = Readonly<{
  providerTemplateName: string;
  variables: readonly WhatsAppManagedTemplateVariableKey[];
  en_IN: string;
  hi: string;
}>;

const VARIABLE_LIMITS: Readonly<Record<WhatsAppManagedTemplateVariableKey, number>> = {
  studentName: 80,
  branchName: 120,
  startDate: 32,
  seatLabel: 40,
  shiftName: 80,
  amount: 32,
  dueDate: 32,
  oldestDueDate: 32,
  studentCount: 8,
  earliestDueDate: 32,
  paymentDate: 32,
  paymentMethod: 40,
  newStatus: 32,
};

const VARIABLE_EXAMPLES: Readonly<
  Record<WhatsAppManagedTemplateLanguage, Record<WhatsAppManagedTemplateVariableKey, string>>
> = {
  en_IN: {
    studentName: "Sample Student",
    branchName: "Sample Branch",
    startDate: "23 Aug 2026",
    seatLabel: "A-12",
    shiftName: "Morning Shift",
    amount: "1,200",
    dueDate: "30 Aug 2026",
    oldestDueDate: "30 Jul 2026",
    studentCount: "2",
    earliestDueDate: "30 Jul 2026",
    paymentDate: "23 Aug 2026",
    paymentMethod: "UPI",
    newStatus: "waived",
  },
  hi: {
    studentName: "उदाहरण विद्यार्थी",
    branchName: "उदाहरण शाखा",
    startDate: "23 अगस्त 2026",
    seatLabel: "A-12",
    shiftName: "सुबह की पाली",
    amount: "1,200",
    dueDate: "30 अगस्त 2026",
    oldestDueDate: "30 जुलाई 2026",
    studentCount: "2",
    earliestDueDate: "30 जुलाई 2026",
    paymentDate: "23 अगस्त 2026",
    paymentMethod: "UPI",
    newStatus: "माफ किया गया",
  },
};

const TEMPLATE_COPY: Readonly<Record<WhatsAppManagedTemplateKey, TemplateCopy>> = {
  WELCOME_GENERAL: {
    providerTemplateName: "lablords_welcome_general_v1",
    variables: ["studentName", "branchName", "startDate"],
    en_IN: "Hi {{1}}, welcome to {{2}}. Your membership started on {{3}}. Please contact the branch team if you need help.",
    hi: "नमस्ते {{1}}, {{2}} में आपका स्वागत है। आपकी सदस्यता {{3}} को शुरू हुई। सहायता के लिए शाखा टीम से संपर्क करें।",
  },
  WELCOME_ALLOCATED: {
    providerTemplateName: "lablords_welcome_allocated_v1",
    variables: ["studentName", "branchName", "seatLabel", "shiftName", "startDate"],
    en_IN: "Hi {{1}}, welcome to {{2}}. Your seat is {{3}} for {{4}}, starting {{5}}.",
    hi: "नमस्ते {{1}}, {{2}} में आपका स्वागत है। {{5}} से {{4}} के लिए आपकी सीट {{3}} है।",
  },
  FEE_RENEWAL_POLITE: {
    providerTemplateName: "lablords_fee_renewal_polite_v1",
    variables: ["studentName", "amount", "branchName", "dueDate"],
    en_IN: "Hi {{1}}, your fee of ₹{{2}} for {{3}} is due on {{4}}. Please ignore this reminder if payment has already been recorded.",
    hi: "नमस्ते {{1}}, {{3}} की ₹{{2}} फीस {{4}} को देय है। यदि भुगतान दर्ज हो चुका है तो इस संदेश को अनदेखा करें।",
  },
  FEE_RENEWAL_FRIENDLY: {
    providerTemplateName: "lablords_fee_renewal_friendly_v1",
    variables: ["studentName", "amount", "branchName", "dueDate"],
    en_IN: "Hi {{1}}, this is a reminder that your ₹{{2}} fee for {{3}} is due on {{4}}. Please ignore it if payment is already recorded.",
    hi: "नमस्ते {{1}}, यह याद दिलाया जाता है कि {{3}} की ₹{{2}} फीस {{4}} को देय है। भुगतान दर्ज हो चुका हो तो इसे अनदेखा करें।",
  },
  PAST_DUE_POLITE: {
    providerTemplateName: "lablords_past_due_polite_v1",
    variables: ["studentName", "amount", "branchName", "oldestDueDate"],
    en_IN: "Hi {{1}}, fee payments totalling ₹{{2}} are pending at {{3}}. The oldest due date is {{4}}. Please contact the branch if payment has already been made.",
    hi: "नमस्ते {{1}}, {{3}} में कुल ₹{{2}} फीस लंबित है। सबसे पुरानी देय तिथि {{4}} है। भुगतान हो चुका हो तो शाखा से संपर्क करें।",
  },
  PAST_DUE_FIRM: {
    providerTemplateName: "lablords_past_due_firm_v1",
    variables: ["studentName", "amount", "branchName", "oldestDueDate"],
    en_IN: "Hi {{1}}, ₹{{2}} in fee payments remains pending at {{3}} from {{4}}. Please contact the branch promptly if this payment has already been made.",
    hi: "नमस्ते {{1}}, {{3}} में {{4}} से ₹{{2}} फीस लंबित है। भुगतान हो चुका हो तो कृपया शीघ्र शाखा से संपर्क करें।",
  },
  MULTI_STUDENT_COLLECTION_SUMMARY: {
    providerTemplateName: "lablords_multi_student_collection_v1",
    variables: ["studentCount", "amount", "branchName", "earliestDueDate"],
    en_IN: "This WhatsApp contact has {{1}} student fee records totalling ₹{{2}} pending at {{3}}. The earliest due date is {{4}}. Please ignore this reminder if payment has already been recorded.",
    hi: "इस WhatsApp संपर्क के {{1}} विद्यार्थी फीस रिकॉर्ड में {{3}} पर कुल ₹{{2}} लंबित है। सबसे पहली देय तिथि {{4}} है। यदि भुगतान दर्ज हो चुका है तो इस संदेश को अनदेखा करें।",
  },
  PAYMENT_CONFIRMATION: {
    providerTemplateName: "lablords_payment_confirmation_v1",
    variables: ["studentName", "amount", "branchName", "paymentDate", "paymentMethod"],
    en_IN: "Hi {{1}}, a payment of ₹{{2}} was recorded for {{3}} on {{4}} using {{5}}. This is a payment confirmation, not a tax invoice.",
    hi: "नमस्ते {{1}}, {{3}} के लिए ₹{{2}} का भुगतान {{4}} को {{5}} से दर्ज हुआ। यह भुगतान पुष्टि है, कर चालान नहीं।",
  },
  PAYMENT_CORRECTION: {
    providerTemplateName: "lablords_payment_correction_v1",
    variables: ["amount", "studentName", "branchName", "paymentDate", "newStatus"],
    en_IN: "Correction: the ₹{{1}} payment record for {{2}} at {{3}}, dated {{4}}, is now marked {{5}}. Please contact the branch if clarification is needed.",
    hi: "सुधार: {{3}} में {{2}} का {{4}} दिनांक वाला ₹{{1}} भुगतान रिकॉर्ड अब {{5}} है। स्पष्टीकरण के लिए शाखा से संपर्क करें।",
  },
};

const FOOTERS: Readonly<Record<WhatsAppManagedTemplateLanguage, string>> = {
  en_IN: "Reply STOP to stop operational updates.",
  hi: "परिचालन अपडेट रोकने के लिए STOP लिखकर भेजें।",
};

const BUTTON_LABELS: Readonly<Record<WhatsAppManagedTemplateLanguage, string>> = {
  en_IN: WHATSAPP_MANAGED_STOP_LABEL,
  hi: "अपडेट रोकें",
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function stableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function hashWhatsAppTemplateComponents(components: unknown) {
  return stableHash(components);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function buildDefinition(
  managedKey: WhatsAppManagedTemplateKey,
  language: WhatsAppManagedTemplateLanguage
): WhatsAppManagedTemplateDefinition {
  const copy = TEMPLATE_COPY[managedKey];
  const providerTemplateName = copy.providerTemplateName.replace(
    /_v1$/,
    `_${language.toLowerCase()}_v1`
  );
  const variables = copy.variables.map(key => ({
    key,
    maxLength: VARIABLE_LIMITS[key],
    example: VARIABLE_EXAMPLES[language][key],
  }));
  const body = copy[language];
  const placeholderMatches = [...body.matchAll(/\{\{([1-9][0-9]*)\}\}/g)]
    .map(match => Number(match[1]));
  const expectedPlaceholders = variables.map((_variable, index) => index + 1);
  if (
    JSON.stringify([...placeholderMatches].sort((left, right) => left - right))
      !== JSON.stringify(expectedPlaceholders)
  ) {
    throw new Error(`Managed template ${managedKey}/${language} has an invalid variable order`);
  }

  const components: readonly WhatsAppManagedTemplateComponent[] = [
    {
      type: "BODY",
      text: body,
      example: { body_text: [variables.map(variable => variable.example)] },
    },
    { type: "FOOTER", text: FOOTERS[language] },
    {
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: BUTTON_LABELS[language] }],
    },
  ];
  const hashInput = {
    managedKey,
    catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
    providerTemplateName,
    language,
    category: "UTILITY",
    parameterFormat: "POSITIONAL",
    variables,
    components,
    stopPayload: WHATSAPP_MANAGED_STOP_PAYLOAD,
  } as const;

  return deepFreeze({
    ...hashInput,
    catalogHash: stableHash(hashInput),
  });
}

const MANAGED_TEMPLATES = deepFreeze(
  Object.fromEntries(
    WHATSAPP_MANAGED_TEMPLATE_KEYS.flatMap(managedKey =>
      WHATSAPP_MANAGED_TEMPLATE_LANGUAGES.map(language => [
        `${managedKey}:${language}`,
        buildDefinition(managedKey, language),
      ])
    )
  ) as Record<string, WhatsAppManagedTemplateDefinition>
);

function isManagedKey(value: unknown): value is WhatsAppManagedTemplateKey {
  return typeof value === "string"
    && (WHATSAPP_MANAGED_TEMPLATE_KEYS as readonly string[]).includes(value);
}

function isManagedLanguage(value: unknown): value is WhatsAppManagedTemplateLanguage {
  return typeof value === "string"
    && (WHATSAPP_MANAGED_TEMPLATE_LANGUAGES as readonly string[]).includes(value);
}

export function getManagedWhatsAppTemplate(
  managedKey: WhatsAppManagedTemplateKey,
  language: WhatsAppManagedTemplateLanguage,
  catalogVersion: number = WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION
) {
  if (
    !isManagedKey(managedKey)
    || !isManagedLanguage(language)
    || catalogVersion !== WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION
  ) {
    throw new WhatsAppManagedTemplateError();
  }
  const definition = MANAGED_TEMPLATES[`${managedKey}:${language}`];
  if (!definition) throw new WhatsAppManagedTemplateError();
  return definition;
}

export function listManagedWhatsAppTemplates(input: {
  languages?: readonly WhatsAppManagedTemplateLanguage[];
  catalogVersion?: number;
} = {}) {
  const catalogVersion = input.catalogVersion ?? WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION;
  if (catalogVersion !== WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION) {
    throw new WhatsAppManagedTemplateError();
  }
  const languages = input.languages ?? WHATSAPP_MANAGED_TEMPLATE_LANGUAGES;
  if (
    languages.length < 1
    || new Set(languages).size !== languages.length
    || languages.some(language => !isManagedLanguage(language))
  ) {
    throw new WhatsAppManagedTemplateError();
  }
  return WHATSAPP_MANAGED_TEMPLATE_KEYS.flatMap(managedKey =>
    languages.map(language => getManagedWhatsAppTemplate(managedKey, language, catalogVersion))
  );
}

export function resolveExactManagedWhatsAppTemplateDefinition(
  input: WhatsAppManagedTemplateDefinition
) {
  if (!input || !isManagedKey(input.managedKey) || !isManagedLanguage(input.language)) {
    throw new WhatsAppManagedTemplateError();
  }
  const canonical = getManagedWhatsAppTemplate(
    input.managedKey,
    input.language,
    input.catalogVersion
  );
  if (
    input !== canonical
    && (
      input.catalogHash !== canonical.catalogHash
      || stableHash({
        managedKey: input.managedKey,
        catalogVersion: input.catalogVersion,
        providerTemplateName: input.providerTemplateName,
        language: input.language,
        category: input.category,
        parameterFormat: input.parameterFormat,
        variables: input.variables,
        components: input.components,
        stopPayload: input.stopPayload,
      }) !== canonical.catalogHash
    )
  ) {
    throw new WhatsAppManagedTemplateError();
  }
  return canonical;
}

function sanitizeVariableValue(variable: WhatsAppManagedTemplateVariable, value: unknown) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new WhatsAppManagedTemplateError();
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !normalized
    || normalized.length > variable.maxLength
    || /\{\{|\}\}|(?:https?:\/\/|www\.)/iu.test(normalized)
  ) {
    throw new WhatsAppManagedTemplateError();
  }
  if (variable.key === "studentCount" && !/^[1-9][0-9]{0,6}$/.test(normalized)) {
    throw new WhatsAppManagedTemplateError();
  }
  if (variable.key === "amount" && !/^[0-9][0-9,]*(?:\.[0-9]{1,2})?$/.test(normalized)) {
    throw new WhatsAppManagedTemplateError();
  }
  return normalized;
}

export function prepareManagedWhatsAppTemplate(
  definition: WhatsAppManagedTemplateDefinition,
  values: Readonly<Record<string, unknown>>
): PreparedManagedWhatsAppTemplate {
  const canonical = resolveExactManagedWhatsAppTemplateDefinition(definition);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new WhatsAppManagedTemplateError();
  }
  const expectedKeys = canonical.variables.map(variable => variable.key);
  const providedKeys = Object.keys(values).sort();
  if (JSON.stringify([...expectedKeys].sort()) !== JSON.stringify(providedKeys)) {
    throw new WhatsAppManagedTemplateError();
  }
  const orderedValues = canonical.variables.map(variable =>
    sanitizeVariableValue(variable, values[variable.key])
  );
  const body = canonical.components.find(component => component.type === "BODY");
  if (!body || body.type !== "BODY") throw new WhatsAppManagedTemplateError();
  const renderedPreview = orderedValues.reduce(
    (rendered, value, index) => rendered.replace(`{{${index + 1}}}`, value),
    body.text
  );
  return deepFreeze({ definition: canonical, orderedValues, renderedPreview });
}

export function managedProviderTemplateMatches(
  providerTemplate: Pick<
    MetaMessageTemplate,
    "name" | "language" | "category" | "components"
  >,
  definition: WhatsAppManagedTemplateDefinition
) {
  const canonical = resolveExactManagedWhatsAppTemplateDefinition(definition);
  return providerTemplate.name === canonical.providerTemplateName
    && providerTemplate.language === canonical.language
    && providerTemplate.category.trim().toUpperCase() === "UTILITY"
    && hashWhatsAppTemplateComponents(providerTemplate.components)
      === hashWhatsAppTemplateComponents(canonical.components);
}
