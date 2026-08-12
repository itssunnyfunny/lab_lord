import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppSelect,
  flattenAppSelectOptions,
  type AppSelectItem,
} from "@/components/ui/AppSelect";

describe("AppSelect", () => {
  const options: AppSelectItem[] = [
    {
      label: "Primary shifts",
      options: [
        { value: "morning", label: "Morning", description: "06:00–10:00" },
        { value: "evening", label: "Evening", disabled: true },
      ],
    },
    { value: "full-day", label: "Full Day" },
  ];

  it("flattens grouped options while carrying group disabled state", () => {
    const flattened = flattenAppSelectOptions([
      ...options,
      { label: "Unavailable", disabled: true, options: [{ value: "night", label: "Night" }] },
    ]);

    expect(flattened.map(option => [option.value, option.group, Boolean(option.disabled)])).toEqual([
      ["morning", "Primary shifts", false],
      ["evening", "Primary shifts", true],
      ["full-day", undefined, false],
      ["night", "Unavailable", true],
    ]);
  });

  it("renders a labelled combobox, selected value, hidden form value, and error linkage", () => {
    const html = renderToStaticMarkup(
      <AppSelect
        id="shift-filter"
        name="shift"
        label="Shift"
        value="morning"
        options={options}
        onValueChange={() => undefined}
        error="Choose an available shift"
        errorId="shift-error"
      />
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('name="shift"');
    expect(html).toContain('value="morning"');
    expect(html).toContain("Morning");
    expect(html).toContain('aria-describedby="shift-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Choose an available shift");
  });

  it("renders placeholder text and a disabled 44px control", () => {
    const html = renderToStaticMarkup(
      <AppSelect
        value=""
        options={options}
        onValueChange={() => undefined}
        placeholder="Choose shift"
        disabled
        aria-label="Shift filter"
      />
    );

    expect(html).toContain("Choose shift");
    expect(html).toContain('disabled=""');
    expect(html).toContain("min-h-11");
    expect(html).toContain('aria-label="Shift filter"');
  });
});
