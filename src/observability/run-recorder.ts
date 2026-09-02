/**
 * Run evidence.
 *
 * Two audiences, which is why there are two formats:
 *
 *   - `events.jsonl` for machines and for grepping. One JSON object per line,
 *     append-only, so a run that crashes still leaves everything up to the
 *     crash.
 *   - `summary.md` and `result.json` for the human who has to work out what
 *     went wrong at 2am.
 *
 * Plus a richer signal on failure: a screenshot with sensitive regions already
 * blacked out, and the accessibility snapshot the resolver was actually looking
 * at when it failed. The AX snapshot matters more than the screenshot for
 * debugging a locator problem — it shows you exactly which candidates existed
 * and what they scored, which a picture cannot.
 *
 * **Everything written here goes through redaction.** That is enforced by
 * routing every write through this class rather than by asking call sites to
 * remember. This is regulated financial data and the evidence directory is the
 * single most likely place for it to escape into a git repository.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep, redactText } from '../policy/redaction.js';

export type RunKind = 'discovery' | 'replay';

export interface RunEvent {
  at: string;
  seq: number;
  kind: string;
  detail: Record<string, unknown>;
}

export class RunRecorder {
  readonly dir: string;
  private seq = 0;
  private readonly events: RunEvent[] = [];
  private readonly consoleEcho: boolean;

  /**
   * Optional live subscriber, for a UI watching a run in progress.
   *
   * It is handed the event *after* redaction, deliberately: a viewer streaming
   * a run gets exactly what the committed evidence gets, and there is no second
   * path out of this class for a raw member record to escape through.
   */
  private readonly onEvent: ((e: RunEvent) => void) | undefined;

  constructor(
    readonly runId: string,
    readonly kind: RunKind,
    baseDir = 'evidence',
    opts: { consoleEcho?: boolean; onEvent?: (e: RunEvent) => void } = {},
  ) {
    this.dir = join(baseDir, `${kind}-${runId}`).replace(/\\/g, '/');
    mkdirSync(this.dir, { recursive: true });
    this.consoleEcho = opts.consoleEcho ?? true;
    this.onEvent = opts.onEvent;
  }

  /**
   * Structured log line. `detail` is deep-redacted before it is written, so a
   * caller that accidentally passes a raw member record cannot leak it.
   */
  event(kind: string, detail: Record<string, unknown> = {}): void {
    const e: RunEvent = {
      at: new Date().toISOString(),
      seq: ++this.seq,
      kind,
      detail: redactDeep(detail),
    };
    this.events.push(e);
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(e)}\n`, 'utf8');
    if (this.consoleEcho) console.log(formatEvent(e));
    // A subscriber must never be able to take the run down with it.
    try {
      this.onEvent?.(e);
    } catch {
      /* a broken viewer is not a failed run */
    }
  }

  /**
   * Paths recorded in evidence and in artifacts always use forward slashes.
   *
   * They end up in YAML that is committed to git, in Markdown links, and in
   * reports read on other machines. A path recorded with backslashes on Windows
   * is a broken link everywhere else, and a spurious diff when the same evidence
   * is regenerated on another platform.
   */
  private path(name: string): string {
    return join(this.dir, name).replace(/\\/g, '/');
  }

  /** PNG bytes are expected to have been masked at capture time, not here. */
  screenshot(name: string, png: Buffer): string {
    const file = this.path(`${name}.png`);
    writeFileSync(file, png);
    this.event('screenshot', { file });
    return file;
  }

  /** Arbitrary structured snapshot — AX inventory, candidate rankings, config. */
  snapshot(name: string, data: unknown): string {
    const file = this.path(`${name}.json`);
    writeFileSync(file, JSON.stringify(redactDeep(data), null, 2), 'utf8');
    return file;
  }

  text(name: string, body: string): string {
    const file = this.path(name);
    writeFileSync(file, redactText(body), 'utf8');
    return file;
  }

  finish(result: unknown, summaryMarkdown: string): void {
    writeFileSync(this.path('result.json'), JSON.stringify(redactDeep(result), null, 2), 'utf8');
    writeFileSync(this.path('summary.md'), redactText(summaryMarkdown), 'utf8');
  }

  all(): readonly RunEvent[] {
    return this.events;
  }

  /** The tail of the log, attached to failure reports so the error is self-contained. */
  tail(n = 12): RunEvent[] {
    return this.events.slice(-n);
  }
}

function formatEvent(e: RunEvent): string {
  const bits = Object.entries(e.detail)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `  [${String(e.seq).padStart(3, '0')}] ${e.kind.padEnd(22)} ${bits}`;
}
