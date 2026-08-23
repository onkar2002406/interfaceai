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
  email: string;
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
