/**
 * Thin, typed-ish wrappers around the Shopify Admin GraphQL API for the
 * subscription module. No database access here: everything returns plain data
 * or throws `ShopifyUserError` so callers decide how to persist/retry.
 */
import { unauthenticated } from "../shopify.server";

export type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

export class ShopifyUserError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ShopifyUserError";
    this.code = code;
  }
}

export async function getAdmin(shop: string): Promise<AdminClient> {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

/** Runs a query and throws on transport/GraphQL errors. */
async function gql<T = any>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json: any = await res.json();
  if (json.errors?.length) {
    throw new ShopifyUserError(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data as T;
}

function assertNoUserErrors(errors: Array<{ field?: string[]; message: string; code?: string }> | undefined) {
  if (errors && errors.length > 0) {
    throw new ShopifyUserError(errors.map((e) => e.message).join("; "), errors[0].code);
  }
}

/* ───────────────────────── shop ───────────────────────── */

export async function fetchShopTimezone(admin: AdminClient): Promise<string | null> {
  try {
    const data = await gql<any>(admin, `#graphql
      query ShopTimezone { shop { ianaTimezone } }`);
    return data?.shop?.ianaTimezone ?? null;
  } catch {
    return null;
  }
}

/* ───────────────────────── selling plans ───────────────────────── */

export interface SellingPlanSpec {
  /** Existing Shopify id when the plan was already synced. */
  sellingPlanId?: string | null;
  name: string;
  label: string;
  interval: "WEEK" | "MONTH";
  intervalCount: number;
  discountPercent: number;
  position: number;
}

function sellingPlanInput(p: SellingPlanSpec, isUpdate: boolean) {
  const base: Record<string, unknown> = {
    name: p.name,
    options: p.label,
    position: p.position,
    category: "SUBSCRIPTION",
    billingPolicy: { recurring: { interval: p.interval, intervalCount: p.intervalCount } },
    deliveryPolicy: {
      recurring: {
        interval: p.interval,
        intervalCount: p.intervalCount,
        preAnchorBehavior: "ASAP",
        cutoff: 0,
        intent: "FULFILLMENT_BEGIN",
      },
    },
    // An explicit policy is always sent so lowering a discount to 0% on update works.
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PERCENTAGE",
          adjustmentValue: { percentage: p.discountPercent },
        },
      },
    ],
  };
  if (isUpdate) base.id = p.sellingPlanId;
  return base;
}

export interface SellingPlanGroupResult {
  groupId: string;
  /** label (`options`) -> selling plan gid, for every plan currently in the group. */
  plans: Record<string, string>;
}

async function readGroup(admin: AdminClient, groupId: string): Promise<SellingPlanGroupResult> {
  const data = await gql<any>(
    admin,
    `#graphql
    query ReadGroup($id: ID!) {
      sellingPlanGroup(id: $id) {
        id
        sellingPlans(first: 50) { nodes { id options } }
      }
    }`,
    { id: groupId },
  );
  const group = data?.sellingPlanGroup;
  if (!group) throw new ShopifyUserError("Selling plan group was not found in Shopify.");
  const plans: Record<string, string> = {};
  for (const n of group.sellingPlans.nodes) plans[n.options?.[0] ?? n.options] = n.id;
  return { groupId: group.id, plans };
}

/** Does the group still exist in Shopify (merchant may have deleted it)? */
export async function sellingPlanGroupExists(admin: AdminClient, groupId: string): Promise<boolean> {
  try {
    await readGroup(admin, groupId);
    return true;
  } catch {
    return false;
  }
}

export async function createSellingPlanGroup(
  admin: AdminClient,
  plans: SellingPlanSpec[],
  productIds: string[],
): Promise<SellingPlanGroupResult> {
  const data = await gql<any>(
    admin,
    `#graphql
    mutation CreateGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
      sellingPlanGroupCreate(input: $input, resources: $resources) {
        sellingPlanGroup { id }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        name: "Subscribe & Save",
        merchantCode: "purrkins-subscribe-and-save",
        options: ["Delivery every"],
        position: 1,
        sellingPlansToCreate: plans.map((p) => sellingPlanInput(p, false)),
      },
      resources: { productIds, productVariantIds: [] },
    },
  );
  assertNoUserErrors(data.sellingPlanGroupCreate.userErrors);
  return readGroup(admin, data.sellingPlanGroupCreate.sellingPlanGroup.id);
}

export async function updateSellingPlanGroup(
  admin: AdminClient,
  groupId: string,
  desired: SellingPlanSpec[],
  removeSellingPlanIds: string[],
): Promise<SellingPlanGroupResult> {
  const toUpdate = desired.filter((p) => p.sellingPlanId);
  const toCreate = desired.filter((p) => !p.sellingPlanId);
  const input: Record<string, unknown> = {};
  if (toUpdate.length) input.sellingPlansToUpdate = toUpdate.map((p) => sellingPlanInput(p, true));
  if (toCreate.length) input.sellingPlansToCreate = toCreate.map((p) => sellingPlanInput(p, false));
  if (removeSellingPlanIds.length) input.sellingPlansToDelete = removeSellingPlanIds;

  if (Object.keys(input).length > 0) {
    const data = await gql<any>(
      admin,
      `#graphql
      mutation UpdateGroup($id: ID!, $input: SellingPlanGroupInput!) {
        sellingPlanGroupUpdate(id: $id, input: $input) {
          sellingPlanGroup { id }
          userErrors { field message code }
        }
      }`,
      { id: groupId, input },
    );
    assertNoUserErrors(data.sellingPlanGroupUpdate.userErrors);
  }
  return readGroup(admin, groupId);
}

export async function deleteSellingPlanGroup(admin: AdminClient, groupId: string) {
  const data = await gql<any>(
    admin,
    `#graphql
    mutation DeleteGroup($id: ID!) {
      sellingPlanGroupDelete(id: $id) { deletedSellingPlanGroupId userErrors { field message code } }
    }`,
    { id: groupId },
  );
  assertNoUserErrors(data.sellingPlanGroupDelete.userErrors);
}

/** Makes the group's product list exactly `productIds`. */
export async function syncGroupProducts(admin: AdminClient, groupId: string, productIds: string[]) {
  const current = await gql<any>(
    admin,
    `#graphql
    query GroupProducts($id: ID!) {
      sellingPlanGroup(id: $id) { products(first: 250) { nodes { id } } }
    }`,
    { id: groupId },
  );
  const have: string[] = (current?.sellingPlanGroup?.products?.nodes ?? []).map((n: any) => n.id);
  const want = new Set(productIds);
  const toAdd = productIds.filter((id) => !have.includes(id));
  const toRemove = have.filter((id) => !want.has(id));

  if (toAdd.length) {
    const r = await gql<any>(
      admin,
      `#graphql
      mutation AddProducts($id: ID!, $ids: [ID!]!) {
        sellingPlanGroupAddProducts(id: $id, productIds: $ids) { userErrors { field message code } }
      }`,
      { id: groupId, ids: toAdd },
    );
    assertNoUserErrors(r.sellingPlanGroupAddProducts.userErrors);
  }
  if (toRemove.length) {
    const r = await gql<any>(
      admin,
      `#graphql
      mutation RemoveProducts($id: ID!, $ids: [ID!]!) {
        sellingPlanGroupRemoveProducts(id: $id, productIds: $ids) { userErrors { field message code } }
      }`,
      { id: groupId, ids: toRemove },
    );
    assertNoUserErrors(r.sellingPlanGroupRemoveProducts.userErrors);
  }
}

export async function fetchProductTitles(
  admin: AdminClient,
  ids: string[],
): Promise<Array<{ id: string; title: string; image: string | null }>> {
  if (ids.length === 0) return [];
  const data = await gql<any>(
    admin,
    `#graphql
    query ProductTitles($ids: [ID!]!) {
      nodes(ids: $ids) { ... on Product { id title featuredMedia { preview { image { url } } } } }
    }`,
    { ids },
  );
  return (data.nodes ?? [])
    .filter(Boolean)
    .map((n: any) => ({ id: n.id, title: n.title, image: n.featuredMedia?.preview?.image?.url ?? null }));
}

/* ───────────────────────── contracts ───────────────────────── */

export interface ContractLine {
  title: string;
  variantTitle: string | null;
  quantity: number;
  price: number;
  variantId: string | null;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  attributes: Array<{ key: string; value: string }>;
}

export interface ContractDetails {
  id: string;
  status: string;
  currencyCode: string;
  createdAt: string;
  nextBillingDate: string | null;
  billingPolicy: { interval: string; intervalCount: number };
  deliveryPolicy: { interval: string; intervalCount: number };
  deliveryPrice: number;
  originOrder: { id: string; name: string; createdAt: string } | null;
  customer: { id: string; email: string | null; name: string | null } | null;
  shippingSummary: string | null;
  attributes: Array<{ key: string; value: string }>;
  lines: ContractLine[];
}

const CONTRACT_CORE = `
  id status currencyCode createdAt nextBillingDate
  billingPolicy { interval intervalCount }
  deliveryPolicy { interval intervalCount }
  deliveryPrice { amount }
  customAttributes { key value }
  originOrder { id name createdAt }
  lines(first: 50) {
    nodes {
      title variantTitle quantity variantId sellingPlanId sellingPlanName
      currentPrice { amount }
      customAttributes { key value }
    }
  }
`;

// Customer name/email/address are "protected customer data". Apps that have not been
// approved for it get an error, so we always have a fallback query without them.
const CONTRACT_PII = `
  customer { id email displayName }
  deliveryMethod {
    ... on SubscriptionDeliveryMethodShipping { address { city provinceCode countryCode } }
  }
`;

function mapContract(c: any): ContractDetails {
  const address = c.deliveryMethod?.address;
  return {
    id: c.id,
    status: c.status,
    currencyCode: c.currencyCode,
    createdAt: c.createdAt,
    nextBillingDate: c.nextBillingDate ?? null,
    billingPolicy: c.billingPolicy,
    deliveryPolicy: c.deliveryPolicy,
    deliveryPrice: Number(c.deliveryPrice?.amount ?? 0),
    originOrder: c.originOrder ?? null,
    customer: c.customer
      ? { id: c.customer.id, email: c.customer.email ?? null, name: c.customer.displayName ?? null }
      : null,
    shippingSummary: address
      ? [address.city, address.provinceCode, address.countryCode].filter(Boolean).join(", ")
      : null,
    attributes: c.customAttributes ?? [],
    lines: (c.lines?.nodes ?? []).map((l: any) => ({
      title: l.title,
      variantTitle: l.variantTitle ?? null,
      quantity: l.quantity,
      price: Number(l.currentPrice?.amount ?? 0),
      variantId: l.variantId ?? null,
      sellingPlanId: l.sellingPlanId ?? null,
      sellingPlanName: l.sellingPlanName ?? null,
      attributes: l.customAttributes ?? [],
    })),
  };
}

export async function fetchContract(admin: AdminClient, contractId: string): Promise<ContractDetails | null> {
  const run = async (withPii: boolean) => {
    const res = await admin.graphql(
      `#graphql
      query Contract($id: ID!) {
        subscriptionContract(id: $id) { ${CONTRACT_CORE} ${withPii ? CONTRACT_PII : ""} }
      }`,
      { variables: { id: contractId } },
    );
    return (await res.json()) as any;
  };

  let json = await run(true);
  if (json.errors?.length || !json.data?.subscriptionContract) {
    const retry = await run(false);
    if (retry.data?.subscriptionContract) json = retry;
    else if (json.errors?.length) throw new ShopifyUserError(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data?.subscriptionContract ? mapContract(json.data.subscriptionContract) : null;
}

export async function setNextBillingDate(admin: AdminClient, contractId: string, when: Date) {
  const data = await gql<any>(
    admin,
    `#graphql
    mutation SetNextBilling($id: ID!, $date: DateTime!) {
      subscriptionContractSetNextBillingDate(contractId: $id, date: $date) {
        contract { id nextBillingDate }
        userErrors { field message }
      }
    }`,
    { id: contractId, date: when.toISOString() },
  );
  assertNoUserErrors(data.subscriptionContractSetNextBillingDate.userErrors);
}

type ContractStatusMutation = "subscriptionContractPause" | "subscriptionContractActivate" | "subscriptionContractCancel";

export async function changeContractStatus(
  admin: AdminClient,
  contractId: string,
  mutation: ContractStatusMutation,
) {
  const data = await gql<any>(
    admin,
    `#graphql
    mutation ChangeStatus($id: ID!) {
      ${mutation}(subscriptionContractId: $id) {
        contract { id status }
        userErrors { field message }
      }
    }`,
    { id: contractId },
  );
  assertNoUserErrors(data[mutation].userErrors);
}

export interface ContractPatch {
  billingPolicy?: { interval: string; intervalCount: number };
  deliveryPolicy?: { interval: string; intervalCount: number };
  customAttributes?: Array<{ key: string; value: string }>;
}

/** Edit flow: open draft -> update -> commit. Aborts cleanly on user errors. */
export async function patchContract(admin: AdminClient, contractId: string, patch: ContractPatch) {
  const opened = await gql<any>(
    admin,
    `#graphql
    mutation OpenDraft($id: ID!) {
      subscriptionContractUpdate(contractId: $id) { draft { id } userErrors { field message } }
    }`,
    { id: contractId },
  );
  assertNoUserErrors(opened.subscriptionContractUpdate.userErrors);
  const draftId: string = opened.subscriptionContractUpdate.draft.id;

  const updated = await gql<any>(
    admin,
    `#graphql
    mutation UpdateDraft($id: ID!, $input: SubscriptionDraftInput!) {
      subscriptionDraftUpdate(draftId: $id, input: $input) { draft { id } userErrors { field message } }
    }`,
    { id: draftId, input: patch },
  );
  assertNoUserErrors(updated.subscriptionDraftUpdate.userErrors);

  const committed = await gql<any>(
    admin,
    `#graphql
    mutation CommitDraft($id: ID!) {
      subscriptionDraftCommit(draftId: $id) { contract { id } userErrors { field message } }
    }`,
    { id: draftId },
  );
  assertNoUserErrors(committed.subscriptionDraftCommit.userErrors);
}

/* ───────────────────────── billing ───────────────────────── */

export type BillingState =
  | { kind: "PENDING" }
  | { kind: "SUCCESS"; orderId: string; orderName: string | null }
  | { kind: "FAILED"; code: string | null; message: string }
  | { kind: "ACTION_REQUIRED"; url: string | null };

function mapAttemptState(attempt: any): BillingState {
  const s = attempt?.state;
  switch (s?.__typename) {
    case "SubscriptionBillingAttemptSuccessState":
      return { kind: "SUCCESS", orderId: s.order.id, orderName: s.order.name ?? null };
    case "SubscriptionBillingAttemptFailedState":
      return {
        kind: "FAILED",
        code: s.error?.code ?? null,
        message: s.error?.message ?? s.error?.code ?? s.error?.__typename ?? "Billing attempt failed",
      };
    case "SubscriptionBillingAttemptActionRequiredState":
      return { kind: "ACTION_REQUIRED", url: s.action?.nextActionUrl ?? null };
    default:
      return { kind: "PENDING" };
  }
}

const ATTEMPT_FIELDS = `
  id
  state {
    __typename
    ... on SubscriptionBillingAttemptSuccessState { order { id name } }
    ... on SubscriptionBillingAttemptFailedState {
      error {
        __typename
        ... on SubscriptionBillingAttemptPaymentError { code message }
        ... on SubscriptionBillingAttemptInventoryError { code message }
      }
    }
    ... on SubscriptionBillingAttemptActionRequiredState {
      action { ... on SubscriptionBillingAttemptPaymentChallenge { nextActionUrl } }
    }
  }
`;

export async function createBillingAttempt(
  admin: AdminClient,
  contractId: string,
  idempotencyKey: string,
): Promise<{ attemptId: string; state: BillingState }> {
  const data = await gql<any>(
    admin,
    `#graphql
    mutation Bill($id: ID!, $key: String!) {
      subscriptionBillingAttemptCreate(
        subscriptionContractId: $id
        subscriptionBillingAttemptInput: { idempotencyKey: $key }
      ) {
        subscriptionBillingAttempt { ${ATTEMPT_FIELDS} }
        userErrors { field message code }
      }
    }`,
    { id: contractId, key: idempotencyKey },
  );
  const payload = data.subscriptionBillingAttemptCreate;
  assertNoUserErrors(payload.userErrors);
  return { attemptId: payload.subscriptionBillingAttempt.id, state: mapAttemptState(payload.subscriptionBillingAttempt) };
}

export async function fetchBillingAttempt(admin: AdminClient, attemptId: string): Promise<BillingState> {
  const data = await gql<any>(
    admin,
    `#graphql
    query Attempt($id: ID!) { subscriptionBillingAttempt(id: $id) { ${ATTEMPT_FIELDS} } }`,
    { id: attemptId },
  );
  return mapAttemptState(data.subscriptionBillingAttempt);
}

export async function fetchOrderName(admin: AdminClient, orderId: string): Promise<string | null> {
  try {
    const data = await gql<any>(admin, `#graphql
      query OrderName($id: ID!) { order(id: $id) { name } }`, { id: orderId });
    return data?.order?.name ?? null;
  } catch {
    return null;
  }
}
