import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { User } from "lucide-react";
import {
  SettingsSaveBar,
  SettingsWorkspace,
} from "@/components/settings/SettingsWorkspace";

describe("settings edit controls", () => {
  it("renders a page-level action in the settings header", () => {
    const html = renderToStaticMarkup(
      <SettingsWorkspace
        title="Account settings"
        subtitle="Manage your account."
        sections={[{ id: "profile", label: "Profile", icon: User }]}
        activeSection="profile"
        onSectionChange={() => undefined}
        actions={<button type="button">Edit settings</button>}
      >
        <section id="profile">Saved profile</section>
      </SettingsWorkspace>
    );

    expect(html).toContain("Edit settings");
    expect(html).toContain("Saved profile");
  });

  it("keeps Cancel available but disables Save until a value changes", () => {
    const html = renderToStaticMarkup(
      <SettingsSaveBar
        visible
        hasChanges={false}
        saving={false}
        status="idle"
        onSave={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(html).toContain("Editing settings.");
    expect(html).toContain("Cancel");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Save changes");
  });
});
