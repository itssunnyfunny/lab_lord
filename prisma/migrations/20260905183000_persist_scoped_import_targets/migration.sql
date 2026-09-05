-- Typed reference ledger; no synthetic replacement of deleted historical targets.
BEGIN;
LOCK TABLE "ImportRow", "ImportRunItem", "Student", "Seat", "Shift", "MultiShift", "SeatAllocation", "Payment" IN SHARE ROW EXCLUSIVE MODE;
CREATE UNIQUE INDEX "ImportRunItem_id_branchId_key" ON "ImportRunItem"(id,"branchId");
CREATE UNIQUE INDEX "SeatAllocation_id_branchId_key" ON "SeatAllocation"(id,"branchId");
CREATE TABLE "ImportTargetReference" (
 "id" TEXT PRIMARY KEY, "branchId" TEXT NOT NULL, "importRowId" TEXT, "importRunItemId" TEXT, "usage" TEXT NOT NULL, "entityType" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "studentId" TEXT,
 "seatId" TEXT,
 "shiftId" TEXT,
 "multiShiftId" TEXT,
 "seatAllocationId" TEXT,
 "paymentId" TEXT,
 CONSTRAINT "ImportTargetReference_snapshot_identity" CHECK (("studentId" IS NULL OR "studentId"="targetId") AND ("seatId" IS NULL OR "seatId"="targetId") AND ("shiftId" IS NULL OR "shiftId"="targetId") AND ("multiShiftId" IS NULL OR "multiShiftId"="targetId") AND ("seatAllocationId" IS NULL OR "seatAllocationId"="targetId") AND ("paymentId" IS NULL OR "paymentId"="targetId")),
 CONSTRAINT "ImportTargetReference_one_source" CHECK (num_nonnulls("importRowId","importRunItemId")=1),
 CONSTRAINT "ImportTargetReference_live_type" CHECK (num_nonnulls("studentId","seatId","shiftId","multiShiftId","seatAllocationId","paymentId")<=1 AND (("entityType"='STUDENT' AND ("seatId" IS NULL AND "shiftId" IS NULL AND "multiShiftId" IS NULL AND "seatAllocationId" IS NULL AND "paymentId" IS NULL)) OR ("entityType"='SEAT' AND ("studentId" IS NULL AND "shiftId" IS NULL AND "multiShiftId" IS NULL AND "seatAllocationId" IS NULL AND "paymentId" IS NULL)) OR ("entityType"='SHIFT' AND ("studentId" IS NULL AND "seatId" IS NULL AND "multiShiftId" IS NULL AND "seatAllocationId" IS NULL AND "paymentId" IS NULL)) OR ("entityType"='MULTI_SHIFT' AND ("studentId" IS NULL AND "seatId" IS NULL AND "shiftId" IS NULL AND "seatAllocationId" IS NULL AND "paymentId" IS NULL)) OR ("entityType"='ALLOCATION' AND ("studentId" IS NULL AND "seatId" IS NULL AND "shiftId" IS NULL AND "multiShiftId" IS NULL AND "paymentId" IS NULL)) OR ("entityType"='PAYMENT' AND ("studentId" IS NULL AND "seatId" IS NULL AND "shiftId" IS NULL AND "multiShiftId" IS NULL AND "seatAllocationId" IS NULL))))
);
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_importRowId_branchId_fkey" FOREIGN KEY ("importRowId","branchId") REFERENCES "ImportRow"(id,"branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_importRunItemId_branchId_fkey" FOREIGN KEY ("importRunItemId","branchId") REFERENCES "ImportRunItem"(id,"branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_studentId_branchId_fkey" FOREIGN KEY ("studentId","branchId") REFERENCES "Student"(id,"branchId") ON DELETE SET NULL ("studentId") ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_seatId_branchId_fkey" FOREIGN KEY ("seatId","branchId") REFERENCES "Seat"(id,"branchId") ON DELETE SET NULL ("seatId") ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_shiftId_branchId_fkey" FOREIGN KEY ("shiftId","branchId") REFERENCES "Shift"(id,"branchId") ON DELETE SET NULL ("shiftId") ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_multiShiftId_branchId_fkey" FOREIGN KEY ("multiShiftId","branchId") REFERENCES "MultiShift"(id,"branchId") ON DELETE SET NULL ("multiShiftId") ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_seatAllocationId_branchId_fkey" FOREIGN KEY ("seatAllocationId","branchId") REFERENCES "SeatAllocation"(id,"branchId") ON DELETE SET NULL ("seatAllocationId") ON UPDATE CASCADE;
ALTER TABLE "ImportTargetReference" ADD CONSTRAINT "ImportTargetReference_paymentId_branchId_fkey" FOREIGN KEY ("paymentId","branchId") REFERENCES "Payment"(id,"branchId") ON DELETE SET NULL ("paymentId") ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ImportTargetReference_importRowId_usage_entityType_targetId_key" ON "ImportTargetReference"("importRowId",usage,"entityType","targetId");
CREATE UNIQUE INDEX "ImportTargetReference_importRunItemId_usage_entityType_targetI_key" ON "ImportTargetReference"("importRunItemId",usage,"entityType","targetId");
CREATE INDEX "ImportTargetReference_branchId_idx" ON "ImportTargetReference"("branchId");
CREATE FUNCTION "record_import_target"(source_table text, source_id text, branch_id text, target_usage text, entity_type text, target_id text, historical boolean) RETURNS void LANGUAGE plpgsql AS $$
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
 EXECUTE format('INSERT INTO "ImportTargetReference" (id,"branchId",%I,usage,"entityType","targetId",%I) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',CASE WHEN source_table='ImportRow' THEN 'importRowId' ELSE 'importRunItemId' END,target_column) USING md5(source_table||':'||source_id||':'||target_usage||':'||entity_type||':'||target_id),branch_id,source_id,target_usage,entity_type,target_id,live_id;
END $$;
CREATE FUNCTION "sync_import_targets"(source_table text, source_id text, branch_id text, source_kind text, source_payload jsonb, source_result jsonb, historical boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text; k text; t text; BEGIN
 -- Keep previously validated references as history until the staging owner is purged.
 IF source_table='ImportRow' THEN
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','STUDENT',source_result->>'studentId',historical);
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','SEAT',source_result->>'seatId',historical);
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','SHIFT',source_result->>'shiftId',historical);
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','MULTI_SHIFT',source_result->>'multiShiftId',historical);
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','ALLOCATION',source_result->>'seatAllocationId',historical);
 PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT','PAYMENT',source_result->>'paymentId',historical);
 FOR k,t IN SELECT * FROM (VALUES ('paymentIds','PAYMENT'),('allocationIds','ALLOCATION')) AS x(k,t) LOOP
  FOR v IN SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(source_result->k)='array' THEN source_result->k ELSE '[]'::jsonb END) LOOP
   PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT',t,v,historical);
  END LOOP;
 END LOOP;
 ELSE
  PERFORM "record_import_target"(source_table,source_id,branch_id,'INPUT','STUDENT',source_payload->>'studentId',historical);
  t:=CASE WHEN source_kind='CONFIG' THEN CASE source_payload->>'type' WHEN 'seat' THEN 'SEAT' WHEN 'shift' THEN 'SHIFT' WHEN 'multi-shift' THEN 'MULTI_SHIFT' ELSE CASE WHEN source_result->'counts' ? 'seats' THEN 'SEAT' WHEN source_result->'counts' ? 'shifts' THEN 'SHIFT' WHEN source_result->'counts' ? 'multiShifts' THEN 'MULTI_SHIFT' END END WHEN source_kind='PAYMENT_CYCLE' THEN 'PAYMENT' ELSE source_kind END;
  FOR v IN SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(source_result->'entityIds')='array' THEN source_result->'entityIds' ELSE '[]'::jsonb END) LOOP
   PERFORM "record_import_target"(source_table,source_id,branch_id,'OUTPUT',t,v,historical);
  END LOOP;
 END IF;
END $$;
-- Backfill permits already-deleted targets as detached history; foreign targets block.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM "ImportRow" LOOP PERFORM "sync_import_targets"('ImportRow',r.id,r."branchId",NULL,NULL,r."createdEntityIds",true); END LOOP;
 FOR r IN SELECT * FROM "ImportRunItem" LOOP PERFORM "sync_import_targets"('ImportRunItem',r.id,r."branchId",r.kind::text,r.payload,r.result,true); END LOOP;
END $$;
CREATE FUNCTION "maintain_import_targets"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='ImportRow' THEN PERFORM "sync_import_targets"(TG_TABLE_NAME,NEW.id,NEW."branchId",NULL,NULL,NEW."createdEntityIds",false);
 ELSE PERFORM "sync_import_targets"(TG_TABLE_NAME,NEW.id,NEW."branchId",NEW.kind::text,NEW.payload,NEW.result,false); END IF;
 RETURN NEW; END $$;
CREATE TRIGGER "ImportRow_targets" AFTER INSERT OR UPDATE OF "createdEntityIds", "branchId" ON "ImportRow" FOR EACH ROW EXECUTE FUNCTION "maintain_import_targets"();
CREATE TRIGGER "ImportRunItem_targets" AFTER INSERT OR UPDATE OF payload,result,kind,"branchId" ON "ImportRunItem" FOR EACH ROW EXECUTE FUNCTION "maintain_import_targets"();
COMMIT;
