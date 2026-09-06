import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { executeBillingProviderAction, confirmReconciledBillingProviderAction } from "@/services/billingProviderAction.service";
import { buildCommercialIntentSnapshot } from "@/services/billingCommercialEvidence.service";
import { setRazorpayClientForTests, RazorpayApiError, type RazorpayApiClient, type RazorpaySubscription } from "@/lib/razorpay";
import { prisma } from "@/lib/prisma";
import { createOrg, createUser } from "@/tests/factories";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";

const response: RazorpaySubscription = { id:"sub_action",entity:"subscription",plan_id:"plan_action",quantity:1,total_count:12,status:"active" };
describe("authoritative billing provider actions", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_action");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
  });
  afterEach(() => { setRazorpayClientForTests(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(async () => { await prisma.$disconnect(); await disconnectDatabase(); });
  async function setup() {
    const user = await createUser(); const organization = await createOrg({ownerId:user.id});
    const leaseToken = randomUUID();
    await testPrisma.organization.update({ where:{id:organization.id},data:{billingMutationLeaseToken:leaseToken,billingMutationLeaseUntil:new Date(Date.now()+120_000)} });
    const subscription = await testPrisma.organizationSubscription.create({data:{organizationId:organization.id,
      providerMode:"TEST",plan:"PRO",amount:499,amountSubunits:49900,totalCount:12,quantity:1,
      razorpayPlanId:response.plan_id,razorpaySubscriptionId:response.id,status:"ACTIVE"}});
    const change = await testPrisma.organizationBillingChange.create({data:{organizationId:organization.id,
      organizationSubscriptionId:subscription.id,...buildCommercialIntentSnapshot({providerMode:"TEST",
        razorpaySubscriptionId:response.id,sourceRazorpayPlanId:response.plan_id,razorpayPlanId:response.plan_id,
        plan:"PRO",quantity:1,unitAmountSubunits:49900,currency:"INR",period:"monthly",interval:1,offer:null,capturedAt:new Date()}),
      type:"PLAN_UPGRADE",status:"PROCESSING",sequence:1,idempotencyKey:randomUUID(),attemptCount:1,processingStartedAt:new Date()}});
    const updateSubscription = vi.fn(async () => response);
    const cancelSubscription = vi.fn(async () => ({...response,status:"cancelled"}));
    setRazorpayClientForTests({updateSubscription,cancelSubscription} as unknown as RazorpayApiClient);
    const input = { organizationId:organization.id,change,leaseToken,purpose:"MUTATE" as const,command:{method:"updateSubscription" as const,args:[response.id,{quantity:1,schedule_change_at:"now" as const}] as [string,{quantity:number;schedule_change_at:"now"}]} };
    return {input,updateSubscription,cancelSubscription};
  }
  it("commits admission before external I/O and reuses the response after local-finalization failure", async () => {
    const {input,updateSubscription}=await setup();
    updateSubscription.mockImplementationOnce(async () => {
      expect(await testPrisma.billingProviderAction.count({where:{organizationId:input.organizationId,status:"ADMITTED"}})).toBe(1);
      // A separate connection can lock the organization during provider I/O.
      await testPrisma.$transaction(async tx => { await tx.$executeRawUnsafe("SET LOCAL lock_timeout='500ms'"); await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${input.organizationId} FOR UPDATE`; });
      return response;
    });
    expect(await executeBillingProviderAction(input)).toEqual(response);
    // Domain finalization is deliberately absent; replay still cannot dispatch.
    expect(await executeBillingProviderAction(input)).toEqual(response);
    expect(updateSubscription).toHaveBeenCalledTimes(1);
  });
  it("retains response loss across lease replacement and conflicts with a new command key", async () => {
    const {input,updateSubscription}=await setup();
    updateSubscription.mockRejectedValueOnce(new Error("response lost"));
    await expect(executeBillingProviderAction(input)).rejects.toThrow("response lost");
    const leaseToken=randomUUID();
    await testPrisma.organization.update({where:{id:input.organizationId},data:{billingMutationLeaseToken:leaseToken}});
    await expect(executeBillingProviderAction({...input,leaseToken})).rejects.toMatchObject({code:"BILLING_MANUAL_REVIEW_REQUIRED"});
    await expect(executeBillingProviderAction({...input,leaseToken,purpose:"CANCEL_SOURCE",command:{method:"cancelSubscription",args:[response.id,{cancel_at_cycle_end:true}]}})).rejects.toMatchObject({code:"BILLING_MANUAL_REVIEW_REQUIRED"});
    expect(updateSubscription).toHaveBeenCalledTimes(1);
  });
  it("fences stale ownership and rejects intent changes in SQL and in the executor", async () => {
    const {input,updateSubscription}=await setup();
    await expect(executeBillingProviderAction({...input,leaseToken:"stale"})).rejects.toMatchObject({code:"BILLING_CHANGE_IN_PROGRESS"});
    expect(updateSubscription).not.toHaveBeenCalled();
    await executeBillingProviderAction(input);
    await expect(executeBillingProviderAction({...input,command:{method:"updateSubscription",args:[response.id,{quantity:2,schedule_change_at:"now"}]}})).rejects.toMatchObject({code:"BILLING_MANUAL_REVIEW_REQUIRED"});
    await expect(testPrisma.billingProviderAction.updateMany({data:{requestHash:"changed"}})).rejects.toThrow(/immutable/);
  });
  it("resolves only the action with matching delayed evidence and permits a distinct source action", async () => {
    const {input,updateSubscription,cancelSubscription}=await setup();
    updateSubscription.mockRejectedValueOnce(new Error("timeout"));
    await expect(executeBillingProviderAction(input)).rejects.toThrow();
    await testPrisma.$transaction(tx=>confirmReconciledBillingProviderAction(tx,{organizationId:input.organizationId,identity:input.change.id,purpose:"CANCEL_SOURCE",provider:response}));
    expect(await testPrisma.billingProviderAction.count({where:{status:"UNKNOWN"}})).toBe(1);
    await testPrisma.$transaction(tx=>confirmReconciledBillingProviderAction(tx,{organizationId:input.organizationId,identity:input.change.id,purpose:"MUTATE",provider:response}));
    await executeBillingProviderAction({...input,purpose:"CANCEL_SOURCE",command:{method:"cancelSubscription",args:[response.id,{cancel_at_cycle_end:true}]}});
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
    expect(await testPrisma.billingProviderAction.count({where:{status:"CONFIRMED"}})).toBe(2);
  });
  it("allows a definite rejection to retry without allowing uncertain admission takeover", async () => {
    const {input,updateSubscription}=await setup();
    updateSubscription.mockRejectedValueOnce(new RazorpayApiError("rejected",{kind:"REQUEST",status:400}));
    await expect(executeBillingProviderAction(input)).rejects.toThrow("rejected");
    await executeBillingProviderAction(input);
    expect(updateSubscription).toHaveBeenCalledTimes(2);
    await expect(testPrisma.billingProviderAction.updateMany({data:{dispatchToken:randomUUID(),status:"ADMITTED"}})).rejects.toThrow(/cannot be taken over/);
  });
});
