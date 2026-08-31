export type DisposableTestDatabaseTarget = {
  databaseName: string;
  hostname: string;
  port: string;
  sanitizedIdentity: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertDisposableTestDatabaseTarget(
  connectionString: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): DisposableTestDatabaseTarget {
  if (!connectionString) {
    throw new Error("Refusing database test work without DATABASE_URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Refusing database test work: DATABASE_URL is invalid.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const hostname = parsed.hostname.toLowerCase();
  const isPostgres = ["postgres:", "postgresql:"].includes(parsed.protocol);
  const deploymentEnvironment = env.VERCEL_ENV?.trim().toLowerCase();

  if (!isPostgres) {
    throw new Error("Refusing database test work: PostgreSQL is required.");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Refusing database test work: host must be loopback/local.");
  }
  if (!databaseName || !databaseName.toLowerCase().includes("test")) {
    throw new Error(
      "Refusing database test work: database name must explicitly contain 'test'."
    );
  }
  if (
    env.NODE_ENV?.trim().toLowerCase() === "production" ||
    deploymentEnvironment === "preview" ||
    deploymentEnvironment === "production"
  ) {
    throw new Error(
      "Refusing database test work in Preview or Production context."
    );
  }

  if (
    env.TEST_DATABASE_URL &&
    env.TEST_DATABASE_RESET_CONFIRM !== databaseName
  ) {
    throw new Error(
      "Refusing database test work: TEST_DATABASE_RESET_CONFIRM must exactly match the explicit test database name."
    );
  }

  const port = parsed.port || "5432";
  return {
    databaseName,
    hostname,
    port,
    sanitizedIdentity: `${hostname}:${port}/${databaseName}`,
  };
}
