"use strict";
async function verifyExternalDeliveryRuntime({ db }) {
  const triggers = ["mass_delivery_mutation_v2", "mass_delivery_delete_v2", "mass_creator_retirement_v2", "mass_agency_retirement_v2", "telegram_new_send_v2"];
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname,c.relname,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname=current_schema() AND t.tgenabled IN ('O','A') AND t.tgname IN (SELECT jsonb_array_elements_text($1::jsonb))`, JSON.stringify(triggers));
  const expectedTables = ["AutomationDelivery", "AutomationDelivery", "CreatorAccount", "Agency", "TelegramDeliveryIntent"];
  if (rows.length !== triggers.length || triggers.some((name, i) => !rows.some(row => row.tgname === name && row.relname === expectedTables[i] && row.proname === `onlinod_${name}`))) throw new Error("EXTERNAL_DELIVERY_PHYSICAL_GUARD_REQUIRED");
  // Resolve expected columns, rather than declaring ready from table names alone.
  await db.$queryRawUnsafe(`SELECT "sourceRevision","retirementProofRevision","activeSequence" FROM "MassCreatorDeliveryState" LIMIT 0`);
  await db.$queryRawUnsafe(`SELECT "sourceRevision","phase","cursor","response","retainUntil" FROM "MassQueueObservation" LIMIT 0`);
  await db.$queryRawUnsafe(`SELECT "observationId","digest" FROM "MassQueueObservationPage" LIMIT 0`);
  await db.$queryRawUnsafe(`SELECT "observationId","queueId" FROM "MassQueueObservationItem" LIMIT 0`);
  const indexes = await require("../../scripts/database/external-delivery-indexes").ensureIndexes(db);
  return { ready: true, generation: "external_delivery_v2", guards: rows.length, indexes: indexes.contracts };
}
module.exports = { verifyExternalDeliveryRuntime };
