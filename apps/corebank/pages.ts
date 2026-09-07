/**
 * Server-rendered views for the CoreBank Servicing Console.
 *
 * The markup here is intentionally hostile, in the specific ways that real
 * legacy enterprise apps are hostile:
 *
 *   - a real <frameset> shell, so perception has to traverse frames
 *   - table-based layout, <font> tags, spacer cells
 *   - ASP.NET-style generated ids (ctl00_ContentPlaceHolder1_txtMbrId) that look
 *     stable but churn across versions
 *   - no data-testid, no aria-label, no placeholder
 *   - **no <label for=...>** on text inputs
 *
 * That last one is the important one. Without a <label for>, Chromium computes
 * an EMPTY accessible name for the input: the field's caption lives in a
 * sibling <td> with no programmatic association. This is the common case in
 * legacy banking software, and it's why the locator model can't just be
 * "role + accessible name" — it needs spatial/structural anchors too. The app
 * is built this way on purpose so the resolver has to earn its keep.
 *
 * Buttons and links DO get accessible names (from value= and link text), which
 * mirrors reality: the controls you press are usually nameable, the fields you
 * type into often aren't.
 */

import type { TenantConfig } from './tenants.js';
import { formatMoney, type Member } from './seed-data.js';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function chrome(t: TenantConfig, title: string, body: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<title>${esc(t.institutionName)} - ${esc(title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css">
  body { font-family: Verdana, Arial, sans-serif; font-size: 11px; margin: 0; background: #f4f4f0; }
  .hdr { background: ${t.accent}; color: #fff; padding: 6px 10px; font-weight: bold; font-size: 12px; }
  .ver { float: right; font-weight: normal; font-size: 10px; opacity: .8; }
  table.grid { border-collapse: collapse; margin: 8px; background: #fff; }
  table.grid td, table.grid th { border: 1px solid #999; padding: 3px 8px; font-size: 11px; }
  table.grid th { background: #dcdcd4; text-align: left; }
  table.form td { padding: 3px 6px; font-size: 11px; }
  .err { color: #a00; font-weight: bold; margin: 8px; }
  .note { margin: 8px; }
  input[type=text], input[type=password], select { font-family: Verdana; font-size: 11px; border: 1px solid #7f9db9; }
  input[type=submit], input[type=button] { font-family: Verdana; font-size: 11px; }
  .modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.45); }
  .modalbox { width: 380px; margin: 90px auto; background: #fff; border: 2px solid #666; padding: 14px; }
</style>
</head>
<body>
<div class="hdr">${esc(t.institutionName)} &nbsp;&#183;&nbsp; Servicing Console
  <span class="ver">CoreBank v${esc(t.productVersion)}</span></div>
${body}
</body>
</html>`;
}

/* ------------------------------------------------------------------ login */

export function loginPage(t: TenantConfig, error?: string): string {
  return chrome(
    t,
    'Sign On',
    `
<div class="note"><font size="2"><b>Staff Sign On</b></font></div>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="/login">
<table class="form" border="0">
  <tr>
    <td align="right"><font color="#333">Operator ID:</font></td>
    <td><input type="text" name="ctl00$txtOperator" id="ctl00_txtOperator" size="22"></td>
  </tr>
  <tr>
    <td align="right"><font color="#333">Password:</font></td>
    <td><input type="password" name="ctl00$txtPwd" id="ctl00_txtPwd" size="22"></td>
  </tr>
  <tr>
    <td>&nbsp;</td>
    <td><input type="submit" name="ctl00$btnSignOn" value="Sign On"></td>
  </tr>
</table>
</form>
<div class="note"><font size="1" color="#666">
  ${esc(t.institutionName)} &#183; CoreBank Servicing Console v${esc(t.productVersion)}
  &#183; install <b>${esc(t.id)}</b><br>
  Authorised staff only. Contact your branch administrator for access.<br>
  Synthetic data only &#8212; no real member information.
</font></div>`,
  );
}

/* -------------------------------------------------------------- frameset */

/**
 * A genuine frameset, not nested divs. Perception must walk frames and the
 * artifact must record which frame a control lives in, or replay will resolve
 * the wrong element in the wrong document.
 */
export function framesetPage(t: TenantConfig): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>
<head><title>${esc(t.institutionName)} - Servicing Console</title></head>
<frameset cols="170,*" border="1">
  <frame name="navFrame" src="/nav" scrolling="no">
  <frame name="contentFrame" src="/content">
</frameset>
</html>`;
}

export function navPage(t: TenantConfig): string {
  const item = (href: string, label: string) =>
    `<tr><td><font size="2"><a href="${href}" target="contentFrame">${esc(label)}</a></font></td></tr>`;
  return chrome(
    t,
    'Menu',
    `<table border="0" cellpadding="4" cellspacing="0" width="100%">
  ${item('/search', t.labels.searchNavLink)}
  ${item('/content', 'Home')}
  <tr><td><hr size="1"></td></tr>
  <tr><td><font size="1" color="#666">Signed on as<br><b>${esc(t.operator)}</b></font></td></tr>
  <tr><td><font size="2"><a href="/logout" target="_top">Sign Off</a></font></td></tr>
</table>`,
  );
}

export function welcomePage(t: TenantConfig): string {
  return chrome(
    t,
    'Home',
    `<div class="note">
  <font size="2"><b>Welcome to the Servicing Console.</b></font>
  <p>Select <b>${esc(t.labels.searchNavLink)}</b> from the menu to begin.</p>
</div>`,
  );
}

/* --------------------------------------------------------------- search */

export function searchPage(t: TenantConfig, error?: string, value = ''): string {
  return chrome(
    t,
    t.labels.searchNavLink,
    `
<div class="note"><font size="2"><b>${esc(t.labels.searchNavLink)}</b></font></div>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="/search">
<table class="form" border="0" cellspacing="0">
  <tr>
    <td align="right" nowrap><font color="#333">${esc(t.labels.memberIdField)}:</font></td>
    <td><input type="text" name="ctl00$ContentPlaceHolder1$txtMbrId"
               id="ctl00_ContentPlaceHolder1_txtMbrId" size="16" maxlength="9"
               value="${esc(value)}"></td>
    <td><input type="submit" name="ctl00$ContentPlaceHolder1$btnFind" value="${esc(t.labels.searchButton)}"></td>
  </tr>
</table>
</form>
<div class="note"><font size="1" color="#666">Enter a numeric member identifier.</font></div>`,
  );
}

export function notFoundPage(t: TenantConfig, id: string): string {
  return chrome(
    t,
    'Search Results',
    `
<div class="note"><font size="2"><b>Search Results</b></font></div>
<div class="note">
  <font color="#a00"><b>No records found</b></font>
  <p>No member matches ${esc(t.labels.memberIdField.toLowerCase())} &quot;${esc(id)}&quot;.</p>
</div>
<div class="note"><font size="2"><a href="/search">Return to ${esc(t.labels.searchNavLink)}</a></font></div>`,
  );
}

export function permissionDeniedPage(t: TenantConfig, id: string): string {
  return chrome(
    t,
    'Access Restricted',
    `
<div class="note"><font size="2"><b>Access Restricted</b></font></div>
<div class="note">
  <font color="#a00"><b>You are not authorized to view this record</b></font>
  <p>Member ${esc(id)} is flagged as a restricted record. Contact your supervisor
     to request elevated entitlements.</p>
  <p><font size="1" color="#666">Reference: ENT-4031</font></p>
</div>
<div class="note"><font size="2"><a href="/search">Return to ${esc(t.labels.searchNavLink)}</a></font></div>`,
  );
}

/* --------------------------------------------------------- member detail */

const COL_HEADERS: Record<string, string> = {
  number: 'Account No.',
  type: 'Type',
  balance: 'Current Balance',
  status: 'Status',
  openedOn: 'Opened',
};

export function memberDetailPage(t: TenantConfig, m: Member): string {
  const head = t.accountColumns.map((c) => `<th>${esc(COL_HEADERS[c])}</th>`).join('');
  const rows = m.accounts
    .map((a) => {
      const cell = (c: string) => {
        switch (c) {
          case 'number':
            return `<td>${esc(a.number)}</td>`;
          case 'type':
            return `<td>${esc(a.type)}</td>`;
          case 'balance':
            return `<td align="right">${esc(formatMoney(a.balance))}</td>`;
          case 'status':
            return `<td>${esc(a.status)}</td>`;
          default:
            return `<td>${esc(a.openedOn)}</td>`;
        }
      };
      return `<tr>${t.accountColumns.map(cell).join('')}</tr>`;
    })
    .join('\n');

  return chrome(
    t,
    'Member Detail',
    `
<div class="note"><font size="2"><b>Member Detail</b></font></div>
<table class="form" border="0" cellspacing="0">
  <tr><td align="right"><font color="#333">${esc(t.labels.memberIdField)}:</font></td>
      <td><b>${esc(m.id)}</b></td>
      <td width="30">&nbsp;</td>
      <td align="right"><font color="#333">Name:</font></td>
      <td><b>${esc(m.lastName)}, ${esc(m.firstName)}</b></td></tr>
  <tr><td align="right"><font color="#333">Branch:</font></td><td>${esc(m.branch)}</td>
      <td>&nbsp;</td>
      <td align="right"><font color="#333">Member Since:</font></td><td>${esc(m.joinedOn)}</td></tr>
  <tr><td align="right"><font color="#333">SSN:</font></td><td>${esc(m.ssn)}</td>
      <td>&nbsp;</td>
      <td align="right"><font color="#333">E-mail:</font></td><td>${esc(m.email)}</td></tr>
  <tr><td align="right"><font color="#333">Phone:</font></td><td>${esc(m.phone)}</td>
      <td>&nbsp;</td>
      <td align="right"><font color="#333">Mailing Address:</font></td><td>${esc(m.address)}</td></tr>
</table>

<div class="note"><font size="2"><b>${esc(t.labels.accountsHeading)}</b></font></div>
<table class="grid" cellspacing="0">
  <tr>${head}</tr>
  ${rows}
</table>

<div class="note">
  <font size="2">
    <a href="/member/${esc(m.id)}/subaccount">${esc(t.labels.openSubAccountLink)}</a>
    &nbsp;|&nbsp;
    <a href="/member/${esc(m.id)}/update">Update Member Details</a>
    &nbsp;|&nbsp;
    <a href="/search">${esc(t.labels.searchNavLink)}</a>
  </font>
</div>`,
  );
}

/* ------------------------------------------------------ open sub-account */

export interface SubAccountValues {
  type?: string;
  deposit?: string;
  nickname?: string;
}

export function subAccountFormPage(
  t: TenantConfig,
  m: Member,
  errors: string[] = [],
  v: SubAccountValues = {},
): string {
  const opt = (val: string) =>
    `<option value="${esc(val)}"${v.type === val ? ' selected' : ''}>${esc(val)}</option>`;
  return chrome(
    t,
    'Open Sub-Account',
    `
<div class="note"><font size="2"><b>${esc(t.labels.openSubAccountLink)}</b> &#8212; Member ${esc(m.id)}</font></div>
${
  errors.length
    ? `<div class="err">Please correct the following:<ul>${errors
        .map((e) => `<li>${esc(e)}</li>`)
        .join('')}</ul></div>`
    : ''
}
<form method="POST" action="/member/${esc(m.id)}/subaccount">
<table class="form" border="0" cellspacing="0">
  <tr><td align="right" nowrap><font color="#333">Account Type:</font></td>
      <td><select name="ctl00$ContentPlaceHolder1$ddlType" id="ctl00_ContentPlaceHolder1_ddlType">
        <option value="">-- select --</option>${opt('Savings')}${opt('Checking')}${opt('Certificate')}
      </select></td></tr>
  <tr><td align="right" nowrap><font color="#333">Initial Deposit:</font></td>
      <td><input type="text" name="ctl00$ContentPlaceHolder1$txtDeposit"
                 id="ctl00_ContentPlaceHolder1_txtDeposit" size="12" value="${esc(v.deposit ?? '')}"></td></tr>
  <tr><td align="right" nowrap><font color="#333">Nickname:</font></td>
      <td><input type="text" name="ctl00$ContentPlaceHolder1$txtNick"
                 id="ctl00_ContentPlaceHolder1_txtNick" size="24" value="${esc(v.nickname ?? '')}"></td></tr>
  <tr><td>&nbsp;</td>
      <td><input type="submit" name="ctl00$ContentPlaceHolder1$btnReview" value="Review"></td></tr>
</table>
</form>
<div class="note"><font size="2"><a href="/member/${esc(m.id)}">Back to Member Detail</a></font></div>`,
  );
}

/**
 * Review screen. Reaching THIS page is safe and reversible; pressing Submit on
 * it is the irreversible act. Splitting them gives the policy layer a natural
 * place to stop.
 */
export function subAccountReviewPage(t: TenantConfig, m: Member, v: Required<SubAccountValues>): string {
  return chrome(
    t,
    'Review Sub-Account',
    `
<div class="note"><font size="2"><b>Review New Sub-Account</b></font></div>
<div class="note"><font color="#333">Confirm the details below. This action cannot be undone.</font></div>
<table class="grid" cellspacing="0">
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>Member</td><td>${esc(m.id)} &#8212; ${esc(m.lastName)}, ${esc(m.firstName)}</td></tr>
  <tr><td>Account Type</td><td>${esc(v.type)}</td></tr>
  <tr><td>Initial Deposit</td><td>${esc(v.deposit)}</td></tr>
  <tr><td>Nickname</td><td>${esc(v.nickname)}</td></tr>
</table>
<form method="POST" action="/member/${esc(m.id)}/subaccount/commit">
  <input type="hidden" name="type" value="${esc(v.type)}">
  <input type="hidden" name="deposit" value="${esc(v.deposit)}">
  <input type="hidden" name="nickname" value="${esc(v.nickname)}">
  <div class="note"><input type="submit" name="ctl00$btnCommit" value="Submit Application"></div>
</form>
<div class="note"><font size="2"><a href="/member/${esc(m.id)}/subaccount">Change details</a></font></div>`,
  );
}

export function subAccountDonePage(t: TenantConfig, m: Member, acctNo: string): string {
  return chrome(
    t,
    'Confirmation',
    `
<div class="note"><font size="2"><b>Confirmation</b></font></div>
<div class="note">
  <font color="#060"><b>Sub-account opened successfully</b></font>
  <p>New account number: <b>${esc(acctNo)}</b></p>
  <p>Member: ${esc(m.id)}</p>
  <p><font size="1" color="#666">Confirmation reference: CFM-${esc(acctNo.slice(-6))}</font></p>
</div>
<div class="note"><font size="2"><a href="/member/${esc(m.id)}">Back to Member Detail</a></font></div>`,
  );
}

/* -------------------------------------------------- update member details */

export interface MemberUpdateValues {
  email?: string;
  phone?: string;
  address?: string;
}

/**
 * The screen that writes to the member record.
 *
 * Two things about its markup are deliberate, because they are what make it a
 * fair test of the locator model rather than a friendly form:
 *
 *   - **No `<label for>` on any input.** The caption is a plain `<td>` sitting
 *     to the left, exactly as in the search screen and exactly as in the real
 *     applications this stands in for. Every field here has to be found by the
 *     caption a human reads beside it, recovered geometrically.
 *   - **Generated ASP.NET names.** `ctl00$ContentPlaceHolder1$txtEmail` is the
 *     name a real WebForms page would emit, and it is not something a person
 *     would ever type — so a recording that leant on it would be recording the
 *     vendor's build number, not the flow.
 *
 * The fields are pre-filled with the current values. That matters for the
 * "mutating, not irreversible" classification: a person or an operator can read
 * what the record said before they change it, and can type it back.
 */
export function memberUpdateFormPage(
  t: TenantConfig,
  m: Member,
  errors: string[] = [],
  v: MemberUpdateValues = {},
): string {
  const email = v.email ?? m.email;
  const phone = v.phone ?? m.phone;
  const address = v.address ?? m.address;

  return chrome(
    t,
    'Update Member Details',
    `
<div class="note"><font size="2"><b>Update Member Details</b> &#8212; ${esc(t.labels.memberIdField)} ${esc(m.id)}</font></div>
${
  errors.length
    ? `<div class="err">Please correct the following:<ul>${errors
        .map((e) => `<li>${esc(e)}</li>`)
        .join('')}</ul></div>`
    : ''
}
<form method="POST" action="/member/${esc(m.id)}/update">
<table class="form" border="0" cellspacing="0">
  <tr><td align="right"><font color="#333">E-mail:</font></td>
      <td><input type="text" name="ctl00$ContentPlaceHolder1$txtEmail"
                 id="ctl00_ContentPlaceHolder1_txtEmail" size="34" value="${esc(email)}"></td></tr>
  <tr><td align="right"><font color="#333">Phone:</font></td>
      <td><input type="text" name="ctl00$ContentPlaceHolder1$txtPhone"
                 id="ctl00_ContentPlaceHolder1_txtPhone" size="24" value="${esc(phone)}"></td></tr>
  <tr><td align="right"><font color="#333">Mailing Address:</font></td>
      <td><input type="text" name="ctl00$ContentPlaceHolder1$txtAddr"
                 id="ctl00_ContentPlaceHolder1_txtAddr" size="44" value="${esc(address)}"></td></tr>
  <tr><td>&nbsp;</td>
      <td><input type="submit" name="ctl00$ContentPlaceHolder1$btnSave" value="Save Changes">
          &nbsp;<a href="/member/${esc(m.id)}">Cancel</a></td></tr>
</table>
</form>`,
  );
}

/**
 * The confirmation, showing the values now on the record.
 *
 * It echoes what was saved rather than saying "done", so the capability has
 * something to assert against and a person has something to read. A success
 * screen that shows no data cannot be checkpointed on anything but its own
 * wording.
 */
export function memberUpdateDonePage(t: TenantConfig, m: Member): string {
  return chrome(
    t,
    'Member Details Updated',
    `
<div class="note"><font size="2"><b>Member details updated</b></font></div>
<div class="note"><font size="2">${esc(t.labels.memberIdField)}: <b>${esc(m.id)}</b></font></div>
<table class="grid" cellspacing="0">
  <tr><th>Field</th><th>Value On Record</th></tr>
  <tr><td>E-mail</td><td>${esc(m.email)}</td></tr>
  <tr><td>Phone</td><td>${esc(m.phone)}</td></tr>
  <tr><td>Mailing Address</td><td>${esc(m.address)}</td></tr>
</table>
<div class="note"><font size="2"><a href="/member/${esc(m.id)}">Back to Member Detail</a></font></div>`,
  );
}

/* ------------------------------------------------- exceptional-state views */

export function appErrorPage(t: TenantConfig, ref: string): string {
  return chrome(
    t,
    'System Error',
    `
<div class="note"><font size="2" color="#a00"><b>Unexpected System Error</b></font></div>
<div class="note">
  <p>The application encountered an error and cannot complete your request.</p>
  <p><font size="1" color="#666">Error reference: ${esc(ref)}<br>
     Please contact the service desk with this reference.</font></p>
</div>`,
  );
}

/**
 * Surprise interstitial. Note it has NO role="dialog" and no aria-label —
 * a legacy app wouldn't bother. Detection therefore has to key on what a human
 * would see (the heading text plus a dismiss button), which is exactly the
 * signal that ports to a desktop or screenshot-only surface.
 */
export function maintenanceInterstitial(inner: string): string {
  return inner.replace(
    '</body>',
    `<div class="modal"><div class="modalbox">
  <font size="2"><b>Scheduled Maintenance Notice</b></font>
  <p><font size="2">This environment will be unavailable Saturday 02:00&#8211;04:00 ET
     for scheduled maintenance. No action is required.</font></p>
  <div align="right"><input type="button" value="Continue"
       onclick="this.parentNode.parentNode.parentNode.style.display='none'"></div>
</div></div>
</body>`,
  );
}

export function privacyInterstitialPage(t: TenantConfig, memberId: string): string {
  return chrome(
    t,
    'Privacy Acknowledgement',
    `
<div class="note"><font size="2"><b>Privacy Acknowledgement Required</b></font></div>
<div class="note">
  <p><font size="2">${esc(t.institutionName)} requires staff to acknowledge the member
     privacy policy before viewing account detail.</font></p>
</div>
<form method="POST" action="/ack-privacy">
  <input type="hidden" name="next" value="/member/${esc(memberId)}">
  <div class="note"><input type="submit" name="btnAck" value="Acknowledge and Continue"></div>
</form>`,
  );
}

export function sessionExpiredRedirect(): string {
  // Legacy apps love a meta-refresh bounce back to sign-on rather than a clean 302.
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head>
<meta http-equiv="refresh" content="0;url=/login?expired=1">
<title>Session Expired</title></head>
<body><font size="2">Your session has expired. Returning to sign on&#8230;</font></body></html>`;
}
