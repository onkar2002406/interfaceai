/**
 * CoreBank Servicing Console — the stand-in for a legacy back-office banking app.
 *
 * One express app per tenant. Routes are IDENTICAL across tenants; only labels,
 * branding, product version, table column order and compliance interstitials
 * differ. That is the shape of the real problem: the same vendor product
 * deployed hundreds of times, configured differently each time.
 *
 * Tenants are separated by port rather than by URL path, mirroring reality
 * (each institution gets its own host) and keeping the allowlist story honest.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getTenant, type TenantConfig } from './tenants.js';
import { FaultController, FAULT_MODES, type FaultMode } from './fault-injection.js';
import { findMember, OPENED_SUBACCOUNTS, type Member } from './seed-data.js';
import * as V from './pages.js';

const VALID_OPERATOR = 'svc.demo';
const VALID_PASSWORD = 'demo1234';
const MIN_OPENING_DEPOSIT = 25;
const SLOW_FAULT_MS = 6000;

interface Session {
  id: string;
  operator: string;
  privacyAcked: boolean;
}

export interface CoreBankApp {
  app: Express;
  tenant: TenantConfig;
  faults: FaultController;
}

export function createCoreBankApp(tenantId: string): CoreBankApp {
  const tenant = getTenant(tenantId);
  const faults = new FaultController();
  const sessions = new Map<string, Session>();
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.disable('x-powered-by');

  /* ------------------------------------------------------------- session */

  const readCookie = (req: Request, name: string): string | undefined => {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
  };

  const sessionOf = (req: Request): Session | undefined => {
    const sid = readCookie(req, 'CBSESSIONID');
    return sid ? sessions.get(sid) : undefined;
  };

  /**
   * Gate for every authenticated page. Also the place the `session` fault fires:
   * the session is destroyed mid-flight and the app bounces to sign-on via a
   * meta-refresh *inside the current frame* — which is exactly what these apps
   * do, and is nastier than a clean 302 because the URL barely changes.
   */
  function requireSession(req: Request, res: Response, next: NextFunction): void {
    const s = sessionOf(req);
    if (s && faults.consume('session', req.path)) {
      sessions.delete(s.id);
      res.status(200).send(V.sessionExpiredRedirect());
      return;
    }
    if (!s) {
      res.status(200).send(V.sessionExpiredRedirect());
      return;
    }
    (req as Request & { session: Session }).session = s;
    next();
  }

  const sess = (req: Request): Session => (req as Request & { session: Session }).session;

  /** Applies the surprise-overlay fault to any content page. */
  const withInterstitial = (req: Request, html: string): string =>
    faults.consume('interstitial', req.path) ? V.maintenanceInterstitial(tenant, html) : html;

  /* --------------------------------------------------------------- auth */

  app.get('/login', (req, res) => {
    const expired = req.query.expired === '1';
    res.send(V.loginPage(tenant, expired ? 'Your session has expired. Please sign on again.' : undefined));
  });

  app.post('/login', (req, res) => {
    const operator = String(req.body['ctl00$txtOperator'] ?? '').trim();
    const password = String(req.body['ctl00$txtPwd'] ?? '');
    if (operator !== VALID_OPERATOR || password !== VALID_PASSWORD) {
      res.status(200).send(V.loginPage(tenant, 'Invalid operator ID or password.'));
      return;
    }
    const id = randomUUID();
    sessions.set(id, { id, operator, privacyAcked: false });
    res.setHeader('Set-Cookie', `CBSESSIONID=${id}; Path=/; HttpOnly; SameSite=Lax`);
    // target="_top" is not available from a form POST, so bounce the whole window.
    res.send(`<html><head><script>if(window.top!==window.self){window.top.location='/';}else{window.location='/';}</script>
      <meta http-equiv="refresh" content="0;url=/"></head><body></body></html>`);
  });

  app.get('/logout', (req, res) => {
    const s = sessionOf(req);
    if (s) sessions.delete(s.id);
    res.setHeader('Set-Cookie', 'CBSESSIONID=; Path=/; Max-Age=0');
    res.redirect('/login');
  });

  /* ----------------------------------------------------------- frameset */

  app.get('/', requireSession, (_req, res) => {
    res.send(V.framesetPage(tenant));
  });

  app.get('/nav', requireSession, (_req, res) => {
    res.send(V.navPage(tenant));
  });

  app.get('/content', requireSession, (_req, res) => {
    res.send(withInterstitial(_req, V.welcomePage(tenant)));
  });

  /* ------------------------------------------------------------- search */

  app.get('/search', requireSession, (_req, res) => {
    res.send(withInterstitial(_req, V.searchPage(tenant)));
  });

  app.post('/search', requireSession, (req, res) => {
    const raw = String(req.body['ctl00$ContentPlaceHolder1$txtMbrId'] ?? '').trim();

    // Input validation errors are business outcomes, not failures: the caller
    // asked a malformed question and deserves a specific answer.
    if (raw === '') {
      res.send(V.searchPage(tenant, `${tenant.labels.memberIdField} is required.`));
      return;
    }
    if (!/^\d+$/.test(raw)) {
      res.send(V.searchPage(tenant, `${tenant.labels.memberIdField} must be numeric.`, raw));
      return;
    }

    const member = findMember(raw);
    if (!member) {
      res.send(V.notFoundPage(tenant, raw));
      return;
    }
    if (member.restricted) {
      res.send(V.permissionDeniedPage(tenant, raw));
      return;
    }
    res.redirect(`/member/${member.id}`);
  });

  /* ------------------------------------------------------ member detail */

  const loadMember = (req: Request, res: Response): Member | undefined => {
    const m = findMember(String(req.params.id ?? ''));
    if (!m) {
      res.send(V.notFoundPage(tenant, String(req.params.id ?? '')));
      return undefined;
    }
    if (m.restricted) {
      res.send(V.permissionDeniedPage(tenant, m.id));
      return undefined;
    }
    return m;
  };

  app.get('/member/:id', requireSession, async (req, res) => {
    // Transient slowness. A fixed sleep in the artifact would be wrong here;
    // the checkpoint poll is what should absorb this.
    if (faults.consume('slow', req.path)) await new Promise((r) => setTimeout(r, SLOW_FAULT_MS));

    if (faults.consume('app_error', req.path)) {
      res.status(500).send(V.appErrorPage(tenant, `SYS-${Date.now().toString(36).toUpperCase()}`));
      return;
    }

    const m = loadMember(req, res);
    if (!m) return;

    if (tenant.privacyInterstitial && !sess(req).privacyAcked) {
      res.send(V.privacyInterstitialPage(tenant, m.id));
      return;
    }

    res.send(withInterstitial(req, V.memberDetailPage(tenant, m)));
  });

  app.post('/ack-privacy', requireSession, (req, res) => {
    sess(req).privacyAcked = true;
    const next = String(req.body.next ?? '/content');
    res.redirect(next.startsWith('/') ? next : '/content');
  });

  /* --------------------------------------------------- open sub-account */

  app.get('/member/:id/subaccount', requireSession, (req, res) => {
    const m = loadMember(req, res);
    if (!m) return;
    res.send(withInterstitial(req, V.subAccountFormPage(tenant, m)));
  });

  app.post('/member/:id/subaccount', requireSession, (req, res) => {
    const m = loadMember(req, res);
    if (!m) return;

    const type = String(req.body['ctl00$ContentPlaceHolder1$ddlType'] ?? '').trim();
    const deposit = String(req.body['ctl00$ContentPlaceHolder1$txtDeposit'] ?? '').trim();
    const nickname = String(req.body['ctl00$ContentPlaceHolder1$txtNick'] ?? '').trim();

    const errors: string[] = [];
    if (!type) errors.push('Account Type is required.');
    if (!deposit) errors.push('Initial Deposit is required.');
    else if (!/^\d+(\.\d{1,2})?$/.test(deposit)) errors.push('Initial Deposit must be a dollar amount.');
    else if (Number(deposit) < MIN_OPENING_DEPOSIT)
      errors.push(`Initial Deposit must be at least $${MIN_OPENING_DEPOSIT}.00.`);
    if (nickname.length > 20) errors.push('Nickname must be 20 characters or fewer.');

    if (errors.length) {
      res.send(V.subAccountFormPage(tenant, m, errors, { type, deposit, nickname }));
      return;
    }
    res.send(V.subAccountReviewPage(tenant, m, { type, deposit, nickname }));
  });

  /** The irreversible act. Everything up to here is safe to replay unattended. */
  app.post('/member/:id/subaccount/commit', requireSession, (req, res) => {
    const m = loadMember(req, res);
    if (!m) return;
    const acctNo = `48209${String(90000 + OPENED_SUBACCOUNTS.length + 1)}`;
    OPENED_SUBACCOUNTS.push({
      memberId: m.id,
      number: acctNo,
      type: String(req.body.type ?? ''),
      initialDeposit: Number(req.body.deposit ?? 0),
      openedAt: new Date().toISOString(),
    });
    res.send(V.subAccountDonePage(tenant, m, acctNo));
  });

  /* ------------------------------------------------------ funds transfer */

  app.get('/member/:id/transfer', requireSession, (req, res) => {
    const m = loadMember(req, res);
    if (!m) return;
    res.send(V.transferPage(tenant, m));
  });

  app.post('/member/:id/transfer', requireSession, (req, res) => {
    const m = loadMember(req, res);
    if (!m) return;
    res.send(
      V.appErrorPage(
        tenant,
        'TRANSFER-BLOCKED: this demo install does not post transfers. The automation layer should never have reached here unattended.',
      ),
    );
  });

  /* ------------------------------------------------------- admin (test) */

  app.post('/_admin/fault', (req, res) => {
    const mode = String(req.body.mode ?? 'none') as FaultMode;
    if (!FAULT_MODES.includes(mode)) {
      res.status(400).json({ error: `unknown fault mode: ${mode}`, known: FAULT_MODES });
      return;
    }
    faults.arm(mode, Number(req.body.times ?? 1), req.body.route ? String(req.body.route) : undefined);
    res.json({ ok: true, tenant: tenant.id, ...faults.status() });
  });

  app.post('/_admin/reset', (_req, res) => {
    faults.reset();
    sessions.clear();
    res.json({ ok: true, tenant: tenant.id });
  });

  app.get('/_admin/status', (_req, res) => {
    res.json({
      tenant: tenant.id,
      institution: tenant.institutionName,
      productVersion: tenant.productVersion,
      faults: faults.status(),
      sessions: sessions.size,
      subAccountsOpened: OPENED_SUBACCOUNTS.length,
    });
  });

  app.use((_req, res) => {
    res.status(404).send(V.appErrorPage(tenant, 'HTTP-404: page not found'));
  });

  return { app, tenant, faults };
}

/** Ports are assigned per tenant so each institution looks like its own host. */
export const TENANT_PORTS: Record<string, number> = {
  base: 4000,
  firstvalley: 4001,
  harborcu: 4002,
};
