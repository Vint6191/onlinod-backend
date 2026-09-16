-- Actual60 INT60.8 — authorization-history destructive-delete lifecycle closure.
--
-- AuthorizationSessionBoundary becomes the compact terminal/tombstone root after
-- RefreshSession raw-rotation retention. The three boundary tables below carry
-- agencyId but intentionally have no FK to Agency because they are immutable
-- authorization-generation history. Agency hard-delete therefore owns their
-- bounded physical erasure explicitly, and new rows must join the same non-FK
-- tenant insert fence used by RefreshSession and the other destructive roots.
--
-- The fence function was introduced by the Actual55 destructive lifecycle. This
-- migration only attaches the existing canonical function to the newly-classified
-- durable authorization-history tables; no second destructive authority is added.

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'AuthorizationSessionBoundary',
    'AgencyMemberAccessEpochBoundary',
    'AgencyCreatorCatalogGenerationBoundary'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_non_fk_tenant_insert_fence" ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_non_fk_tenant_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()',
      v_table
    );
  END LOOP;
END;
$$;
