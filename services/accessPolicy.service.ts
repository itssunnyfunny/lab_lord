import { prisma } from "@/lib/prisma";
import { BRANCH_CAPABILITIES, type BranchCapabilityKey } from "@/lib/branchCapabilities";
import type { BillingEntitlement } from "@/lib/billingPlans";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";
import type { BranchAccess, StaffAction } from "@/types";
import type { Prisma } from "@/app/generated/prisma/client";
import { EntitlementService } from "@/services/entitlement.service";
import { buildOwnerPermissions, buildStaffPermissions } from "@/services/branchActionPolicy";

type Client = Prisma.TransactionClient | typeof prisma;
const issuedContexts = new WeakSet<object>();
declare const contextBrand: unique symbol;
export type BranchAccessContext = Readonly<{
  [contextBrand]: true; actorId: string; branchId: string; branchName: string;
  organizationId: string; isOwner: boolean; role: BranchAccess["role"];
  staffId?: string; permissions: Readonly<Record<StaffAction, boolean>>;
}>;
export class BranchAccessNotFoundError extends Error {
  readonly code = "BRANCH_NOT_FOUND";
  constructor() { super("Branch not found"); this.name = "BranchAccessNotFoundError"; }
}
const ACTION_ENTITLEMENTS: Partial<Record<StaffAction,BillingEntitlement>> = {
  staff_management:"STAFF_MANAGEMENT", analytics:"ADVANCED_ANALYTICS",
  view_whatsapp:"WHATSAPP_AUTOMATION", send_whatsapp:"WHATSAPP_AUTOMATION",
  manage_whatsapp:"WHATSAPP_AUTOMATION", receive_whatsapp_reports:"WHATSAPP_AUTOMATION",
};

/** Interactive policy boundary. Actor IDs originate in authenticated server
 * entry points. Contexts are issued here, frozen, never globally cached, and
 * re-resolved before an operation accepts one from another service. */
export class AccessPolicy {
  static async resolveBranch(actorId: string, branchId: string, client: Client = prisma): Promise<BranchAccessContext> {
    const branch = await client.branch.findUnique({where:{id:branchId},include:{organization:true}});
    if (!branch) throw new BranchAccessNotFoundError();
    const isOwner = branch.organization.ownerId === actorId;
    const staff = isOwner ? null : await client.staff.findUnique({where:{userId_branchId:{userId:actorId,branchId}},
      include:{permissionOverrides:{select:{action:true,allowed:true}}}});
    if (!isOwner && !staff) throw new BranchAccessNotFoundError();
    const context = Object.freeze({actorId,branchId,branchName:branch.name,organizationId:branch.organizationId,
      isOwner,role:isOwner ? "OWNER" : staff!.role,...(staff ? {staffId:staff.id} : {}),
      permissions:Object.freeze(isOwner ? buildOwnerPermissions() : buildStaffPermissions(staff!.role,staff!.permissionOverrides)),
    }) as BranchAccessContext;
    issuedContexts.add(context); return context;
  }

  static assertIssuedContext(context: BranchAccessContext): void {
    if (!context || !issuedContexts.has(context)) throw new Error("Unauthorized: Invalid server access context");
  }

  private static assertPermission(context: BranchAccessContext, action: StaffAction) {
    this.assertIssuedContext(context);
    if (!context.permissions[action]) throw new Error(`Unauthorized: Permission '${action}' is disabled for this staff member`);
  }

  static async authorizeRole(actorId: string, branchId: string, action: StaffAction, client: Client = prisma) {
    const context = await this.resolveBranch(actorId,branchId,client);
    this.assertPermission(context,action); return context;
  }

  static async authorizeAction(actorId: string, branchId: string, action: StaffAction, client: Client = prisma, write = false) {
    const context = await this.authorizeRole(actorId,branchId,action,client);
    const entitlement = ACTION_ENTITLEMENTS[action];
    if (entitlement) await EntitlementService.assertOrganizationEntitlement(context.organizationId,entitlement,client);
    if (write) await EntitlementService.assertBranchWritable(branchId,client);
    return context;
  }

  static async authorizeCapability(actorId: string, branchId: string, capability: BranchCapabilityKey, client: Client = prisma) {
    const context = await this.resolveBranch(actorId,branchId,client);
    const requirement = BRANCH_CAPABILITIES[capability] as {permissions?:readonly StaffAction[];entitlement?:BillingEntitlement;mutation?:boolean};
    const entitlements = new Set<BillingEntitlement>();
    for (const permission of requirement.permissions ?? []) {
      this.assertPermission(context,permission);
      if (ACTION_ENTITLEMENTS[permission]) entitlements.add(ACTION_ENTITLEMENTS[permission]!);
    }
    if (requirement.entitlement) entitlements.add(requirement.entitlement);
    for (const entitlement of entitlements) await EntitlementService.assertOrganizationEntitlement(context.organizationId,entitlement,client);
    if (requirement.mutation) await EntitlementService.assertBranchWritable(branchId,client);
    return context;
  }

  static async recheckCapability(context: BranchAccessContext, capability: BranchCapabilityKey, client: Client = prisma) {
    this.assertIssuedContext(context);
    return this.authorizeCapability(context.actorId,context.branchId,capability,client);
  }

  static async authorizeRecord(actorId: string, branchId: string | null | undefined, action: StaffAction,
    label: "Student" | "Payment" | "Seat" | "Shift" | "Multi-shift" | "Allocation", client: Client = prisma, write = false) {
    if (!branchId) throw new Error(`${label} not found`);
    try { return await this.authorizeAction(actorId,branchId,action,client,write); }
    catch (error) { if (error instanceof BranchAccessNotFoundError) throw new Error(`${label} not found`); throw error; }
  }

  static async branchProjection(actorId: string, branchId: string, client: Client = prisma): Promise<BranchAccess> {
    const context = await this.resolveBranch(actorId,branchId,client);
    const profile = await EntitlementService.getOrganizationProfile(context.organizationId,client);
    return {branchId,branchName:context.branchName,organizationId:context.organizationId,isOwner:context.isOwner,
      role:context.role,...(context.staffId ? {staffId:context.staffId} : {}),permissions:{...context.permissions},
      effectivePlan:profile.effectivePlan,entitlements:profile.entitlements};
  }

  static async readOwnerOrganization<I extends Prisma.OrganizationInclude>(actorId: string, organizationId: string, include: I, client: Client = prisma) {
    const organization = await client.organization.findFirst({where:{id:organizationId,ownerId:actorId},include});
    if (!organization) throw new OrganizationAccessNotFoundError();
    return organization as Prisma.OrganizationGetPayload<{include:I}>;
  }

  static async selectOwnerOrganization<S extends Prisma.OrganizationSelect>(actorId: string, organizationId: string, select: S, client: Client = prisma) {
    const organization = await client.organization.findFirst({where:{id:organizationId,ownerId:actorId},select});
    if (!organization) throw new OrganizationAccessNotFoundError();
    return organization as Prisma.OrganizationGetPayload<{select:S}>;
  }

  /** Billing recovery deliberately checks ownership without requiring an active branch. */
  static async readOwnerBranch<I extends Prisma.BranchInclude>(actorId: string, branchId: string, include: I, client: Client = prisma) {
    const branch = await client.branch.findFirst({where:{id:branchId,organization:{ownerId:actorId}},include});
    if (!branch) throw new BranchAccessNotFoundError();
    return branch as Prisma.BranchGetPayload<{include:I}>;
  }

  static async authorizeOrganization(actorId: string, organizationId: string, options: {write?:boolean;entitlement?:BillingEntitlement} = {}, client: Client = prisma) {
    const organization = await client.organization.findFirst({where:{id:organizationId,ownerId:actorId},select:{id:true}});
    if (!organization) throw new OrganizationAccessNotFoundError();
    if (options.entitlement) await EntitlementService.assertOrganizationEntitlement(organizationId,options.entitlement,client);
    if (options.write) await EntitlementService.assertOrganizationWritable(organizationId,client);
    return organization;
  }
}
