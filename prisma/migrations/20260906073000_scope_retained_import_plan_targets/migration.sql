-- Retained retry-plan input IDs are scoped before becoming executable run items.
BEGIN;
LOCK TABLE "ImportPlan", "ImportTargetReference", "Student" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "ImportTargetReference" ADD COLUMN "importPlanId" TEXT;
ALTER TABLE "ImportTargetReference" DROP CONSTRAINT "ImportTargetReference_one_source";
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_one_source" CHECK (num_nonnulls("importRowId","importRunItemId","importPlanId")=1);
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_importPlanId_branchId_fkey" FOREIGN KEY ("importPlanId","branchId") REFERENCES "ImportPlan"(id,"branchId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ImportTargetReference_importPlanId_usage_entityType_targetId_key" ON "ImportTargetReference"("importPlanId",usage,"entityType","targetId");
CREATE OR REPLACE FUNCTION "record_import_target"(source_table text, source_id text, branch_id text, target_usage text, entity_type text, target_id text, historical boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_table text; target_column text; target_branch text; live_id text; BEGIN
 IF target_id IS NULL OR target_id='' THEN RETURN; END IF;
 IF EXISTS (SELECT 1 FROM "ImportTargetReference" WHERE id=md5(source_table||':'||source_id||':'||target_usage||':'||entity_type||':'||target_id) AND "branchId"=branch_id) THEN RETURN; END IF;
 CASE entity_type
 WHEN 'STUDENT' THEN target_table:='Student'; target_column:='studentId';
 WHEN 'SEAT' THEN target_table:='Seat'; target_column:='seatId';
 WHEN 'SHIFT' THEN target_table:='Shift'; target_column:='shiftId';
 WHEN 'MULTI_SHIFT' THEN target_table:='MultiShift'; target_column:='multiShiftId';
 WHEN 'ALLOCATION' THEN target_table:='SeatAllocation'; target_column:='seatAllocationId';
 WHEN 'PAYMENT' THEN target_table:='Payment'; target_column:='paymentId';
 ELSE RAISE EXCEPTION 'Unsupported import target type'; END CASE;
 EXECUTE format('SELECT "branchId" FROM %I WHERE id=$1 FOR KEY SHARE',target_table) INTO target_branch USING target_id;
 IF target_branch IS NOT NULL AND target_branch <> branch_id THEN RAISE EXCEPTION 'Import target belongs to a different branch' USING ERRCODE='23503'; END IF;
 IF target_branch IS NULL AND NOT historical THEN RAISE EXCEPTION 'Import target no longer exists' USING ERRCODE='23503'; END IF;
 live_id:=CASE WHEN target_branch IS NOT NULL THEN target_id ELSE NULL END;
 EXECUTE format('INSERT INTO "ImportTargetReference" (id,"branchId",%I,usage,"entityType","targetId",%I) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',CASE source_table WHEN 'ImportRow' THEN 'importRowId' WHEN 'ImportRunItem' THEN 'importRunItemId' WHEN 'ImportPlan' THEN 'importPlanId' END,target_column) USING md5(source_table||':'||source_id||':'||target_usage||':'||entity_type||':'||target_id),branch_id,source_id,target_usage,entity_type,target_id,live_id;
END $$;
CREATE FUNCTION "sync_import_plan_targets"(plan_id text, branch_id text, snapshot jsonb, historical boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item jsonb; BEGIN
 FOR item IN SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot->'items')='array' THEN snapshot->'items' ELSE '[]'::jsonb END) LOOP
  PERFORM "record_import_target"('ImportPlan',plan_id,branch_id,'INPUT','STUDENT',item->'payload'->>'studentId',historical);
 END LOOP;
END $$;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT * FROM "ImportPlan" LOOP PERFORM "sync_import_plan_targets"(p.id,p."branchId",p.snapshot,true); END LOOP;
END $$;
CREATE FUNCTION "maintain_import_plan_targets"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM "sync_import_plan_targets"(NEW.id,NEW."branchId",NEW.snapshot,false); RETURN NEW;
END $$;
CREATE TRIGGER "ImportPlan_targets" AFTER INSERT OR UPDATE OF snapshot,"branchId" ON "ImportPlan" FOR EACH ROW EXECUTE FUNCTION "maintain_import_plan_targets"();
COMMIT;
