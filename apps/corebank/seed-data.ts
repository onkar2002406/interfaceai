/**
 * Seed data for the fake credit-union servicing console.
 *
 * All of it is synthetic. Account numbers are deliberately shaped like the real
 * thing (so the redaction patterns get exercised) but belong to nobody.
 */

export interface Account {
  /** Displayed in full by the app — the automation layer is what must redact it. */
  number: string;
  type: 'Savings' | 'Checking' | 'Certificate';
  balance: number;
  status: 'Open' | 'Dormant' | 'Closed';
  openedOn: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  ssn: string;
  /** Editable from the Update Member Details screen and by capability. */
  email: string;
  /** Editable. */
  phone: string;
  /** Editable. */
  address: string;
  branch: string;
  joinedOn: string;
  accounts: Account[];
  /**
   * Some members are restricted to higher-privilege staff. Hitting one is a
   * legitimate *business outcome* (PERMISSION_DENIED), not a system failure —
   * the caller needs to know, and nothing is broken.
   */
  restricted?: boolean;
}

export const MEMBERS: Member[] = [
  {
    id: '10001',
    firstName: 'Dana',
    lastName: 'Whitfield',
    ssn: '412-55-9087',
    email: 'dana.whitfield@example.invalid',
    phone: '(503) 555-0142',
    address: '118 Alder Court, Riverside',
    branch: 'Riverside',
    joinedOn: '2014-03-11',
    accounts: [
      { number: '4820117735', type: 'Savings', balance: 8412.55, status: 'Open', openedOn: '2014-03-11' },
      { number: '4820117736', type: 'Checking', balance: 1290.04, status: 'Open', openedOn: '2014-03-11' },
    ],
  },
  {
    id: '10002',
    firstName: 'Marcus',
    lastName: 'Oyelaran',
    ssn: '388-21-4410',
    email: 'marcus.o@example.invalid',
    phone: '(503) 555-0188',
    address: '92 Northgate Way, Apt 4B',
    branch: 'Northgate',
    joinedOn: '2019-08-02',
    accounts: [
      { number: '4820224419', type: 'Savings', balance: 250.0, status: 'Open', openedOn: '2019-08-02' },
      { number: '4820224420', type: 'Certificate', balance: 15000.0, status: 'Open', openedOn: '2021-01-15' },
    ],
  },
  {
    id: '10003',
    firstName: 'Priya',
    lastName: 'Ramanathan',
    ssn: '501-77-1123',
    email: 'priya.r@example.invalid',
    phone: '(971) 555-0107',
    address: '40 Elm Terrace, Riverside',
    branch: 'Riverside',
    joinedOn: '2008-11-27',
    accounts: [
      { number: '4820331188', type: 'Savings', balance: 63207.19, status: 'Open', openedOn: '2008-11-27' },
    ],
  },
  {
    id: '10004',
    firstName: 'Tomas',
    lastName: 'Kereszti',
    ssn: '229-64-0032',
    email: 'tomas.k@example.invalid',
    phone: '(503) 555-0231',
    address: '7 Eastview Row',
    branch: 'Eastview',
    joinedOn: '2022-05-19',
    accounts: [
      { number: '4820447701', type: 'Checking', balance: 42.13, status: 'Open', openedOn: '2022-05-19' },
      { number: '4820447702', type: 'Savings', balance: 0.0, status: 'Dormant', openedOn: '2022-05-19' },
    ],
  },
  {
    id: '10007',
    firstName: 'Eleanor',
    lastName: 'Voss',
    ssn: '600-13-7788',
    email: 'e.voss@example.invalid',
    phone: '(503) 555-0100',
    address: '1 Executive Plaza, Suite 900',
    branch: 'Executive',
    joinedOn: '2001-02-04',
    restricted: true,
    accounts: [
      { number: '4820770001', type: 'Savings', balance: 1204889.42, status: 'Open', openedOn: '2001-02-04' },
    ],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

/**
 * Writes new contact details onto a member record.
 *
 * The single mutation point for member data, called by the `POST
 * /member/:id/update` handler — which is reached both by a human clicking
 * through the website and by the `update_member_details` capability driving the
 * same screen. There is deliberately no second, automation-only write path: if
 * the capability could write somewhere the website could not read, replaying it
 * would prove nothing about driving a real console.
 *
 * Mutates the seeded array in place, so changes last until the process
 * restarts. Note the three tenant instances run in one process and share this
 * array, which is the honest simplification to make here — three separate
 * member directories would be more realistic and would test nothing extra.
 */
export function updateMember(
  id: string,
  patch: { email?: string; phone?: string; address?: string },
): Member | undefined {
  const m = findMember(id);
  if (!m) return undefined;
  if (patch.email !== undefined) m.email = patch.email;
  if (patch.phone !== undefined) m.phone = patch.phone;
  if (patch.address !== undefined) m.address = patch.address;
  return m;
}

export function formatMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** In-memory sub-accounts opened during a session. Reset when the server restarts. */
export const OPENED_SUBACCOUNTS: Array<{
  memberId: string;
  number: string;
  type: string;
  initialDeposit: number;
  openedAt: string;
}> = [];

/** Pristine copy of the seeded records, taken before anything can mutate them. */
const SEED_SNAPSHOT: Member[] = structuredClone(MEMBERS);

/**
 * Restores the seeded records and clears the opened-account log.
 *
 * Opening a sub-account genuinely mutates a member record, which makes the
 * fixture stateful: an opened account survives until the process ends, so a
 * test or a demo that opens one changes what the next one sees. That is correct
 * for an irreversible action and wrong for a fixture, so the harness gets a way
 * to put the app back — `/_admin/reset`, which is already on the policy DENY
 * list precisely so the automation cannot reach its own test hooks.
 *
 * The three tenant instances share this array, so a reset through any one of
 * them resets all three. Same simplification as `updateMember` above.
 */
export function resetData(): void {
  MEMBERS.splice(0, MEMBERS.length, ...structuredClone(SEED_SNAPSHOT));
  OPENED_SUBACCOUNTS.length = 0;
}

const ACCOUNT_TYPES: ReadonlyArray<Account['type']> = ['Savings', 'Checking', 'Certificate'];

/**
 * Narrows a submitted account type. The commit POST is form data like any
 * other, so the three products the form offers are re-checked here rather than
 * trusted because the previous screen rendered a <select>.
 */
export function asAccountType(value: string): Account['type'] | undefined {
  return ACCOUNT_TYPES.find((t) => t === value);
}

/**
 * The member's existing OPEN account of a given type, if they hold one.
 *
 * The institution permits one open account per product, so this is what the
 * sub-account screens check before opening another. Only `Open` counts: a
 * dormant or closed account of the same type is history rather than a conflict,
 * and refusing to reopen one would be a rule no institution actually has.
 */
export function openAccountOfType(m: Member, type: Account['type']): Account | undefined {
  return m.accounts.find((a) => a.type === type && a.status === 'Open');
}

/**
 * Opens a new share account on a member record.
 *
 * The single mutation point for account data, for the same reason `updateMember`
 * above is the single mutation point for contact details: the account has to
 * land on `m.accounts`, because that is the array the member detail screen
 * renders. Recording an opened account somewhere the website cannot read it
 * would make a successful replay unfalsifiable — the run would report success,
 * the confirmation page would say so, and the member record would be unchanged.
 *
 * `OPENED_SUBACCOUNTS` still gets a row. It holds the opening deposit and the
 * timestamp, which the member record has no column for, and it is what
 * `/_admin/status` counts.
 *
 * Mutates the seeded array in place, so an opened account lasts until the
 * process restarts — and, unlike a contact-detail edit, cannot be typed back.
 * That is the point of classifying this step `irreversible`.
 */
export function openSubAccount(
  id: string,
  input: { type: Account['type']; deposit: number },
): Account | undefined {
  const m = findMember(id);
  if (!m) return undefined;

  const account: Account = {
    number: `48209${String(90000 + OPENED_SUBACCOUNTS.length + 1)}`,
    type: input.type,
    balance: input.deposit,
    status: 'Open',
    openedOn: new Date().toISOString().slice(0, 10),
  };
  m.accounts.push(account);
  OPENED_SUBACCOUNTS.push({
    memberId: m.id,
    number: account.number,
    type: account.type,
    initialDeposit: input.deposit,
    openedAt: new Date().toISOString(),
  });
  return account;
}
