export class BillingChangeInProgressError extends Error {
  readonly code = "BILLING_CHANGE_IN_PROGRESS";
  readonly existingChangeId: string;

  constructor(
    existingChangeId: string,
    message = "Another billable change is already awaiting authorization or cutover"
  ) {
    super(message);
    this.name = "BillingChangeInProgressError";
    this.existingChangeId = existingChangeId;
  }
}

export class BillingReplacementNotReadyError extends Error {
  readonly code = "BILLING_REPLACEMENT_NOT_READY";

  constructor(message = "The replacement mandate is not ready for cutover") {
    super(message);
    this.name = "BillingReplacementNotReadyError";
  }
}

export class BillingManualReviewRequiredError extends Error {
  readonly code = "BILLING_MANUAL_REVIEW_REQUIRED";
  readonly resolutionOutcome = "MANUAL_REVIEW_RETAINED" as const;
  readonly changeId: string;

  constructor(
    changeId: string,
    message = "Provider evidence remains ambiguous; manual billing review is still required"
  ) {
    super(message);
    this.name = "BillingManualReviewRequiredError";
    this.changeId = changeId;
  }
}
