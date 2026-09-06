-- Read-only counts after migration 20260905180000. Missing historical targets detach; foreign targets block.
WITH refs AS (
SELECT 'Student' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'studentId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'Seat' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'seatId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'Shift' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'shiftId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'MultiShift' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'multiShiftId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'SeatAllocation' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'seatAllocationId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'Payment' entity_type,r."branchId" branch_id,r."createdEntityIds"->>'paymentId' target_id FROM "ImportRow" r
UNION ALL
SELECT 'Payment',r."branchId",jsonb_array_elements_text(CASE WHEN jsonb_typeof(r."createdEntityIds"->'paymentIds')='array' THEN r."createdEntityIds"->'paymentIds' ELSE '[]'::jsonb END) FROM "ImportRow" r
UNION ALL
SELECT 'SeatAllocation',r."branchId",jsonb_array_elements_text(CASE WHEN jsonb_typeof(r."createdEntityIds"->'allocationIds')='array' THEN r."createdEntityIds"->'allocationIds' ELSE '[]'::jsonb END) FROM "ImportRow" r
UNION ALL
SELECT 'Student',"branchId",payload->>'studentId' FROM "ImportRunItem"
UNION ALL
SELECT CASE kind::text WHEN 'STUDENT' THEN 'Student' WHEN 'ALLOCATION' THEN 'SeatAllocation' WHEN 'PAYMENT_CYCLE' THEN 'Payment' WHEN 'CONFIG' THEN CASE WHEN payload->>'type'='seat' OR result->'counts' ? 'seats' THEN 'Seat' WHEN payload->>'type'='shift' OR result->'counts' ? 'shifts' THEN 'Shift' WHEN payload->>'type'='multi-shift' OR result->'counts' ? 'multiShifts' THEN 'MultiShift' END END,"branchId",jsonb_array_elements_text(CASE WHEN jsonb_typeof(result->'entityIds')='array' THEN result->'entityIds' ELSE '[]'::jsonb END) FROM "ImportRunItem"
), targets AS (
SELECT 'Student' entity_type,id,"branchId" branch_id FROM "Student"
UNION ALL
SELECT 'Seat' entity_type,id,"branchId" branch_id FROM "Seat"
UNION ALL
SELECT 'Shift' entity_type,id,"branchId" branch_id FROM "Shift"
UNION ALL
SELECT 'MultiShift' entity_type,id,"branchId" branch_id FROM "MultiShift"
UNION ALL
SELECT 'SeatAllocation' entity_type,id,"branchId" branch_id FROM "SeatAllocation"
UNION ALL
SELECT 'Payment' entity_type,id,"branchId" branch_id FROM "Payment"
) SELECT r.entity_type,COUNT(*) AS references,COUNT(*) FILTER (WHERE t.id IS NULL) AS detached_history,COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.branch_id<>r.branch_id) AS foreign_blockers FROM refs r LEFT JOIN targets t ON t.entity_type=r.entity_type AND t.id=r.target_id WHERE r.target_id IS NOT NULL AND r.target_id<>'' GROUP BY r.entity_type;
