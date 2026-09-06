-- Read-only; restricted opaque plan/target IDs. Missing historical targets detach.
SELECT p.id AS plan_id, p."branchId", item->'payload'->>'studentId' AS target_id,
 CASE WHEN s.id IS NULL THEN 'DETACHED_HISTORY' ELSE 'FOREIGN_BLOCKER' END AS disposition
FROM "ImportPlan" p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.snapshot->'items')='array' THEN p.snapshot->'items' ELSE '[]'::jsonb END) item
LEFT JOIN "Student" s ON s.id=item->'payload'->>'studentId'
WHERE NULLIF(item->'payload'->>'studentId','') IS NOT NULL AND (s.id IS NULL OR s."branchId"<>p."branchId");
