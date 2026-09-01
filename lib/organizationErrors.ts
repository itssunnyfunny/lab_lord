export const ORGANIZATION_ACCESS_NOT_FOUND_MESSAGE = "Organization not found";

export class OrganizationAccessNotFoundError extends Error {
  readonly code = "ORGANIZATION_NOT_FOUND";

  constructor() {
    super(ORGANIZATION_ACCESS_NOT_FOUND_MESSAGE);
    this.name = "OrganizationAccessNotFoundError";
  }
}

export class OrganizationValidationError extends Error {
  readonly code = "ORGANIZATION_INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "OrganizationValidationError";
  }
}
