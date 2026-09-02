"use strict";

class AutomationDeliveryAdoptionError extends Error {
  constructor(message = "Idempotency key is bound to a delivery outside the expected Automation authority") {
    super(message);
    this.name = "AutomationDeliveryAdoptionError";
    this.code = "AUTOMATION_IDEMPOTENCY_CONFLICT";
    this.status = 409;
  }
}

function assertAutomationDeliveryAdoption(delivery, expected = {}) {
  if (!delivery) return null;
  const fields = ["agencyId", "creatorId", "moduleKey", "actionType"];
  if (delivery.originKind !== "AUTOMATION") throw new AutomationDeliveryAdoptionError();
  for (const field of fields) {
    if (expected[field] != null && String(delivery[field] ?? "") !== String(expected[field])) {
      throw new AutomationDeliveryAdoptionError(`Idempotency key is bound to another Automation ${field}`);
    }
  }
  return delivery;
}

module.exports = { AutomationDeliveryAdoptionError, assertAutomationDeliveryAdoption };
