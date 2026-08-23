/**
 * Human-readable run reports, written into the evidence directory.
 *
 * The JSONL event log is for grepping; this is for the person who has to work
 * out what happened. A failure report should read like a sentence — "step s3
 * (submit the search) expected the member detail screen; the page said Access
 * Restricted" — not like a stack trace.
 */

import type { ReplayResult } from '../replay/outcomes.js';
import type { DiscoveryTrace } from '../agent/loop.js';
import type { Capability } from '../capability/schema.js';

export function renderDiscoverySummary(trace: DiscoveryTrace, capability: Capability | null): string {
  const lines: string[] = [];
  lines.push(`# Discovery — ${trace.goalTemplate}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Outcome | **${trace.outcome.kind}** |`);
  lines.push(`| Run | \`${trace.runId}\` |`);
  lines.push(`| Model | ${trace.provider}:${trace.model} |`);
  lines.push(`| Tenant | ${trace.tenant} (${trace.product}) |`);
  lines.push(`| Model calls | ${trace.usage.calls} |`);
  lines.push(`| Tokens | ${trace.usage.promptTokens} prompt / ${trace.usage.completionTokens} completion |`);
  lines.push(`| Steps taken | ${trace.steps.length} |`);

  if (trace.outcome.kind !== 'success') {
    lines.push('');
    lines.push(`## Why it stopped\n\n${trace.outcome.why}`);
  }

  lines.push('\n## What the model did\n');
  lines.push('| # | Tool | Target | Its stated reason | OK |');
  lines.push('|---|---|---|---|---|');
  for (const s of trace.steps) {
    const target = s.actedOn ? s.actedOn.name || s.actedOn.proximateLabels[0] || s.actedOn.role : '—';
    lines.push(`| ${s.index} | ${s.toolName} | ${target} | ${s.intent} | ${s.ok ? 'yes' : 'no'} |`);
  }

  if (capability) {
    lines.push('\n## Compiled capability\n');
    lines.push(`\`${capability.metadata.name}@${capability.metadata.version}\` — **${capability.metadata.approval}**`);
    lines.push('');
    lines.push(`- **Inputs:** ${capability.spec.inputs.map((i) => `\`${i.name}\` (${i.type}, ${i.sensitivity})`).join(', ') || 'none'}`);
    lines.push(`- **Outputs:** ${capability.spec.outputs.map((o) => `\`${o.name}\` (${o.type})`).join(', ') || 'none'}`);
    lines.push(`- **Declared business outcomes:** ${capability.spec.outcomes.business.map((b) => `\`${b.code}\``).join(', ') || 'none'}`);
    lines.push('');
    lines.push('The model contributed the order of actions, which element each touched, and the prose intent of');
    lines.push('each step. Locators, checkpoints, risk classes and the error taxonomy were derived by the compiler');
    lines.push('and inherited from the product profile — not authored by the model.');
  }

  return lines.join('\n');
}

export function renderReplaySummary(r: ReplayResult): string {
  const lines: string[] = [];
  const h = (s: string): void => void lines.push(`\n## ${s}\n`);

  lines.push(`# Replay — ${r.capability}@${r.capabilityVersion}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Status | **${r.status}** |`);
  lines.push(`| Run | \`${r.runId}\` |`);
  lines.push(`| Tenant | ${r.tenant} (${r.product}) |`);
  lines.push(`| Started | ${r.startedAt} |`);
  lines.push(`| Duration | ${r.durationMs} ms |`);
  lines.push(`| Overrides applied | ${r.appliedOverrides.length} |`);
  lines.push(`| Drift signals | ${r.driftSignals.length} |`);

  switch (r.status) {
    case 'success':
      h('Outputs');
      lines.push('```json');
      lines.push(JSON.stringify(r.outputs, null, 2));
      lines.push('```');
      break;

    case 'business_outcome':
      h('Business outcome');
      lines.push(`**\`${r.code}\`** at step \`${r.atStep}\` (condition \`${r.conditionId}\`)`);
      lines.push('');
      lines.push(r.message);
      lines.push('');
      lines.push(
        '> This is a legitimate answer to the question asked, not a malfunction. ' +
          'Retrying with the same inputs will produce the same result.',
      );
      break;

    case 'escalated':
      h('Escalation');
      lines.push(`Intervention \`${r.interventionId}\` at step \`${r.atStep}\` — resolution: **${r.resolution}**`);
      lines.push('');
      lines.push(r.reason);
      if (r.operatorNote) lines.push(`\nOperator note: ${r.operatorNote}`);
      break;

    case 'failed':
      h('Failure');
      lines.push(`**\`${r.error.class}\`** at step \`${r.error.stepId}\``);
      lines.push('');
      lines.push(`- **Step intent:** ${r.error.stepIntent}`);
      lines.push(`- **Expected:** ${r.error.expected}`);
      lines.push(`- **Observed:** ${r.error.observed}`);
      lines.push(`- **Recoveries tried:** ${r.error.recoveriesTried.join(', ') || 'none'}`);
      lines.push('');
      lines.push(r.error.message);
      break;
  }

  h('Steps');
  lines.push('| # | Step | Intent | Action | Status | ms | Locator |');
  lines.push('|---|---|---|---|---|---|---|');
  r.steps.forEach((s, i) => {
    const loc = s.resolution
      ? `${s.resolution.score} via \`${s.resolution.strategy}\`${s.resolution.drift ? ' ⚠︎drift' : ''}`
      : '—';
    lines.push(
      `| ${i + 1} | \`${s.stepId}\` | ${s.intent} | ${s.actionType} | ${s.status} | ${s.durationMs} | ${loc} |`,
    );
  });

  const recoveries = r.steps.flatMap((s) => s.recoveries);
  if (recoveries.length) {
    h('Recovery attempts');
    lines.push('| Condition | Handler | Attempt | OK | Note |');
    lines.push('|---|---|---|---|---|');
    for (const rec of recoveries) {
      lines.push(`| \`${rec.conditionId}\` | ${rec.handler} | ${rec.attempt} | ${rec.ok ? 'yes' : 'no'} | ${rec.note} |`);
    }
  }

  if (r.appliedOverrides.length) {
    h('Tenant overrides applied');
    for (const o of r.appliedOverrides) {
      lines.push(`- \`${o.path}\` — ${o.why}`);
    }
  }

  if (r.driftSignals.length) {
    h('Drift signals');
    lines.push(
      'Each of these resolved successfully, but not by the signal it was recorded with. ' +
        'That is the earliest cheap warning that this tenant has diverged — it is information, not a failure.',
    );
    lines.push('');
    lines.push('| Step | Wanted | Matched | Score | Strategy |');
    lines.push('|---|---|---|---|---|');
    for (const d of r.driftSignals) {
      lines.push(`| \`${d.stepId}\` | ${d.expected} | ${d.matched || '—'} | ${d.score} | \`${d.strategy}\` |`);
    }
  }

  if (r.blockedNavigations.length) {
    h('Navigations blocked by the allowlist');
    for (const u of r.blockedNavigations) lines.push(`- ${u}`);
  }

  h('Evidence');
  // Forward slashes: these are read as markdown, on whatever platform.
  const dir = r.evidenceDir.replace(/\\/g, '/');
  lines.push(`- \`${dir}/events.jsonl\` — structured event log`);
  lines.push(`- \`${dir}/result.json\` — full machine-readable result`);
  lines.push(`- screenshots and accessibility snapshots for any failure are in the same directory`);

  return lines.join('\n');
}
