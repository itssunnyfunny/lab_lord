import { describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "../../setup/testDatabaseSafety";

describe("test database safety", () => {
  it("accepts an explicitly confirmed loopback PostgreSQL test database", () => {
    expect(
      assertDisposableTestDatabaseTarget(
        "postgresql://user:secret@127.0.0.1:5433/lab_lords_test",
        {
          NODE_ENV: "test",
          TEST_DATABASE_URL:
            "postgresql://user:secret@127.0.0.1:5433/lab_lords_test",
          TEST_DATABASE_RESET_CONFIRM: "lab_lords_test",
        }
      )
    ).toEqual({
      databaseName: "lab_lords_test",
      hostname: "127.0.0.1",
      port: "5433",
      sanitizedIdentity: "127.0.0.1:5433/lab_lords_test",
    });
  });

  it.each([
    ["remote host", "postgresql://u:p@db.example.test/lab_test", {}],
    ["developer database", "postgresql://u:p@localhost/mydb", {}],
    ["Preview", "postgresql://u:p@localhost/lab_test", { VERCEL_ENV: "preview" }],
    [
      "Production",
      "postgresql://u:p@localhost/lab_test",
      { NODE_ENV: "production" },
    ],
    ["non-PostgreSQL", "mysql://u:p@localhost/lab_test", {}],
  ])("rejects %s", (_name, url, env) => {
    expect(() => assertDisposableTestDatabaseTarget(url, env)).toThrow(
      /Refusing database test work/
    );
  });

  it("rejects an explicit target without an exact reset confirmation", () => {
    expect(() =>
      assertDisposableTestDatabaseTarget(
        "postgresql://u:p@localhost/lab_test",
        { TEST_DATABASE_URL: "set", TEST_DATABASE_RESET_CONFIRM: "other_test" }
      )
    ).toThrow(/must exactly match/);
  });
});
