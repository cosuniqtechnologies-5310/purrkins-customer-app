/**
 * Duplicate-submission rules shared by the free sample / contact / unlock-benefit forms.
 *
 * - Same phone AND same name  -> allowed (unlimited submissions, reuses the existing customer).
 * - Same phone, different name -> rejected.
 * - Same (real) email belonging to a different person -> rejected.
 */

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export interface ExistingCustomer {
  id: string;
  phone: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  tags: string[];
  note?: string | null;
}

export interface ConflictResult {
  /** Customer matched by phone (reuse this for updates when there is no conflict). */
  phoneCustomer: ExistingCustomer | null;
  /** Customer matched by email. */
  emailCustomer: ExistingCustomer | null;
  /** When set, the submission must be rejected with this message. */
  conflictMessage: string | null;
}

const CUSTOMER_FIELDS = `id phone email firstName lastName tags note`;

export function isPlaceholderEmail(email?: string | null): boolean {
  return !email || email.trim() === "" || email.includes("noemail");
}

export function last10Digits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

/**
 * Canonical E.164 form for Indian numbers ("+91 74023 95469", "07402395469", "7402395469" -> "+917402395469").
 * Searching/saving the raw string breaks on spaces and makes Shopify reject the save with
 * "Phone has already been taken" even though the customer exists.
 */
export function normalizePhone(phone: string): string {
  const digits = last10Digits(phone);
  return digits.length === 10 ? `+91${digits}` : phone.trim();
}

function normalizeName(name?: string | null): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drops the "." placeholder last name too
    .replace(/\s+/g, " ")
    .trim();
}

function fullName(c: Pick<ExistingCustomer, "firstName" | "lastName">): string {
  return normalizeName(`${c.firstName || ""} ${c.lastName || ""}`);
}

function namesMatch(submittedName: string | undefined | null, c: ExistingCustomer): boolean {
  const submitted = normalizeName(submittedName);
  // No name supplied -> nothing to compare against.
  if (!submitted) return true;
  const existing = fullName(c);
  // Existing record has no name (e.g. created by email login) -> treat as the same person.
  if (!existing) return true;
  if (submitted === existing) return true;
  // "Kowsalya" vs "Kowsalya S" / "Kowsalya ." -> same first name and one side has no last name.
  const [sFirst, ...sRest] = submitted.split(" ");
  const [eFirst, ...eRest] = existing.split(" ");
  return sFirst === eFirst && (sRest.length === 0 || eRest.length === 0);
}

async function searchCustomers(admin: AdminClient, query: string, first = 1): Promise<ExistingCustomer[]> {
  const res = await admin.graphql(
    `#graphql
    query findCustomer($query: String!) {
      customers(first: ${first}, query: $query) {
        edges { node { ${CUSTOMER_FIELDS} } }
      }
    }`,
    { variables: { query } }
  );
  const data = (await res.json()) as any;
  if (data.errors?.length) {
    throw new Error("Search Error: " + JSON.stringify(data.errors));
  }
  return (data.data?.customers?.edges ?? []).map((e: any) => e.node);
}

async function searchCustomer(admin: AdminClient, query: string): Promise<ExistingCustomer | null> {
  return (await searchCustomers(admin, query))[0] ?? null;
}

async function findByPhone(admin: AdminClient, phone: string): Promise<ExistingCustomer | null> {
  const digits = last10Digits(phone);
  const e164 = normalizePhone(phone);
  // Shopify matches phone strings exactly, so try every format we may have stored,
  // then a plain text search; always verify the digits so a loose hit is never trusted.
  const queries = Array.from(
    new Set([`phone:"${e164}"`, `phone:${e164}`, `phone:${digits}`, `phone:"${digits}"`, digits].filter(Boolean))
  );
  for (const query of queries) {
    const hits = await searchCustomers(admin, query, 5);
    const found = hits.find((c) => c.phone && last10Digits(c.phone) === digits);
    if (found) return found;
  }
  return null;
}

export async function checkCustomerConflict(
  admin: AdminClient,
  input: { name?: string | null; phone: string; email?: string | null }
): Promise<ConflictResult> {
  const phoneCustomer = await findByPhone(admin, input.phone);

  // Same number + same name: always allowed, no further restrictions.
  if (phoneCustomer && namesMatch(input.name, phoneCustomer)) {
    return { phoneCustomer, emailCustomer: null, conflictMessage: null };
  }

  if (phoneCustomer) {
    return {
      phoneCustomer,
      emailCustomer: null,
      conflictMessage: "This mobile number is already registered with a different name.",
    };
  }

  // New phone number: the email (if real) must not belong to someone else.
  let emailCustomer: ExistingCustomer | null = null;
  if (!isPlaceholderEmail(input.email)) {
    emailCustomer = await searchCustomer(admin, `email:${input.email!.trim()}`);
    if (emailCustomer) {
      const sameOwner = !emailCustomer.phone && namesMatch(input.name, emailCustomer);
      if (!sameOwner) {
        return {
          phoneCustomer: null,
          emailCustomer,
          conflictMessage: "This email is already registered with a different name or mobile number.",
        };
      }
    }
  }

  return { phoneCustomer: null, emailCustomer, conflictMessage: null };
}

