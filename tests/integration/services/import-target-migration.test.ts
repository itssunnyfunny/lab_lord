import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";

const migration = readFileSync("prisma/migrations/20260905183000_persist_scoped_import_targets/migration.sql", "utf8");
const planMigration = readFileSync("prisma/migrations/20260906073000_scope_retained_import_plan_targets/migration.sql", "utf8");
const targets = ["Student", "Seat", "Shift", "MultiShift", "SeatAllocation", "Payment"];
describe("persisted import target migration", () => {
  let client: Client, schema: string;
  beforeEach(async () => {
    assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    schema = `import_targets_${randomUUID().replaceAll("-", "")}`;
    let sql = `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE "ImportRow" (id text PRIMARY KEY,"branchId" text NOT NULL,"createdEntityIds" jsonb, UNIQUE(id,"branchId"));
      CREATE TABLE "ImportRunItem" (id text PRIMARY KEY,"branchId" text NOT NULL,kind text,payload jsonb,result jsonb);
      CREATE TABLE "ImportPlan" (id text PRIMARY KEY,"branchId" text NOT NULL,snapshot jsonb,UNIQUE(id,"branchId"));`;
    for (const t of targets) sql += `CREATE TABLE "${t}" (id text PRIMARY KEY,"branchId" text NOT NULL${t !== "SeatAllocation" ? ',UNIQUE(id,"branchId")' : ''}); INSERT INTO "${t}" VALUES ('${t}_a','a'),('${t}_b','b');`;
    sql += `INSERT INTO "ImportRow" VALUES ('row','a','{"studentId":"Student_a","paymentIds":["Payment_a"],"seatId":"deleted-seat"}');
      INSERT INTO "ImportRunItem" VALUES ('item','a','CONFIG',NULL,'{"entityIds":["Shift_a"],"counts":{"shifts":1}}');`;
    await client.query(sql);
  });
  afterEach(async () => { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); });
  it("preserves deleted history and rejects foreign JSON and direct ledger writes", async () => {
    await client.query(migration);
    const refs = (await client.query(`SELECT "targetId","studentId","seatId","shiftId" FROM "ImportTargetReference" ORDER BY "targetId"`)).rows;
    expect(refs).toHaveLength(4);
    expect(refs.find(r => r.targetId === "deleted-seat")).toMatchObject({ seatId: null });
    const fieldByTable: Record<string,string> = {Student:"studentId",Seat:"seatId",Shift:"shiftId",MultiShift:"multiShiftId",SeatAllocation:"seatAllocationId",Payment:"paymentId"};
    for (const table of targets) {
      await expect(client.query(`UPDATE "ImportRow" SET "createdEntityIds"=$1 WHERE id='row'`, [JSON.stringify({[fieldByTable[table]]:`${table}_b`})])).rejects.toMatchObject({code:"23503"});
    }
    await expect(client.query(`UPDATE "ImportRunItem" SET payload='{"studentId":"Student_b"}' WHERE id='item'`)).rejects.toMatchObject({code:"23503"});
    await expect(client.query(`UPDATE "ImportTargetReference" SET "studentId"='Student_b',"targetId"='Student_b' WHERE "targetId"='Student_a'`)).rejects.toMatchObject({code:"23503"});
    await client.query(`DELETE FROM "Student" WHERE id='Student_a'; UPDATE "ImportRow" SET "createdEntityIds"="createdEntityIds" WHERE id='row'`);
    expect((await client.query(`SELECT "studentId","targetId","branchId" FROM "ImportTargetReference" WHERE "targetId"='Student_a'`)).rows)
      .toEqual([{studentId:null,targetId:"Student_a",branchId:"a"}]);
  });
  it("checks completion after payload redaction and each result type", async () => {
    await client.query(migration);
    for (const [kind, type, table] of [["CONFIG","multi-shift","MultiShift"],["STUDENT",null,"Student"],["ALLOCATION",null,"SeatAllocation"],["PAYMENT_CYCLE",null,"Payment"]]) {
      await expect(client.query(`UPDATE "ImportRunItem" SET kind=$1,payload=$2,result=$3 WHERE id='item'`, [kind,JSON.stringify({type}),JSON.stringify({entityIds:[`${table}_b`]})])).rejects.toMatchObject({code:"23503"});
      await client.query(`UPDATE "ImportRunItem" SET kind=$1,payload=$2,result=$3 WHERE id='item'`, [kind,JSON.stringify({type}),JSON.stringify({entityIds:[`${table}_a`]})]);
    }
  });
  it.each(["row", "item"])("blocks foreign historical %s targets atomically", async source => {
    if (source === "row") await client.query(`UPDATE "ImportRow" SET "createdEntityIds"='{"studentId":"Student_b"}'`);
    else await client.query(`UPDATE "ImportRunItem" SET result='{"entityIds":["Shift_b"],"counts":{"shifts":1}}'`);
    await expect(client.query(migration)).rejects.toThrow(/different branch/);
    await client.query("ROLLBACK");
    expect((await client.query(`SELECT to_regclass('"ImportTargetReference"') name`)).rows[0].name).toBeNull();
    expect((await client.query(`SELECT count(*)::int n FROM "ImportRow"`)).rows[0].n).toBe(1);
  });
  it("scopes retained plan inputs, keeps missing history, and rejects foreign plan/ledger writes", async () => {
    await client.query(migration);
    await client.query(`INSERT INTO "ImportPlan" VALUES ('plan','a','{"items":[{"payload":{"studentId":"Student_a"}},{"payload":{"studentId":"deleted-student"}}]}')`);
    await client.query(planMigration);
    const refs = (await client.query(`SELECT "targetId","studentId" FROM "ImportTargetReference" WHERE "importPlanId"='plan' ORDER BY "targetId"`)).rows;
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(expect.arrayContaining([{ targetId: "Student_a", studentId: "Student_a" }, { targetId: "deleted-student", studentId: null }]));
    await expect(client.query(`UPDATE "ImportPlan" SET snapshot='{"items":[{"payload":{"studentId":"Student_b"}}]}' WHERE id='plan'`)).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO "ImportPlan" VALUES ('missing','a','{"items":[{"payload":{"studentId":"unknown"}}]}')`)).rejects.toMatchObject({ code: "23503" });
    await client.query(`INSERT INTO "ImportPlan" VALUES ('foreign-plan','b','{}')`);
    await expect(client.query(`UPDATE "ImportTargetReference" SET "importPlanId"='foreign-plan' WHERE "importPlanId"='plan'`)).rejects.toMatchObject({ code: "23503" });
    await client.query(`DELETE FROM "Student" WHERE id='Student_a'; UPDATE "ImportPlan" SET snapshot=snapshot WHERE id='plan'`);
    expect((await client.query(`SELECT "studentId" FROM "ImportTargetReference" WHERE "importPlanId"='plan' AND "targetId"='Student_a'`)).rows[0].studentId).toBeNull();
  });
  it("blocks foreign historical plan inputs without changing plans or the old ledger", async () => {
    await client.query(migration);
    await client.query(`INSERT INTO "ImportPlan" VALUES ('plan','a','{"items":[{"payload":{"studentId":"Student_b"}}]}')`);
    await expect(client.query(planMigration)).rejects.toThrow(/different branch/);
    await client.query("ROLLBACK");
    expect((await client.query(`SELECT count(*)::int n FROM "ImportPlan"`)).rows[0].n).toBe(1);
    expect((await client.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='ImportTargetReference' AND column_name='importPlanId'`, [schema])).rows[0].n).toBe(0);
  });
});
