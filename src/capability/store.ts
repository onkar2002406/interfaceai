/**
 * Capability storage.
 *
 * Flat YAML files on disk, one per version, named `<name>@<version>.yaml`.
 *
 * That is a deliberate choice over a database. These artifacts are *reviewed
 * and approved by humans* — approval is the gate for unattended irreversible
 * replay — which means the natural home for them is the same place code review
 * already happens. A capability lands as a pull request, a reviewer reads the
 * step intents and the declared outcomes in the diff, and approving it is a
 * commit. A row in Postgres gets none of that for free.
 *
 * YAML rather than JSON for the same reason: comments survive, and a diff of a
 * changed locator is legible.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CapabilitySchema, type Capability, capabilityRef } from './schema.js';

export class CapabilityStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private fileFor(name: string, version: string): string {
    return join(this.dir, `${name}@${version}.yaml`);
  }

  save(capability: Capability): string {
    const parsed = CapabilitySchema.parse(capability);
    const path = this.fileFor(parsed.metadata.name, parsed.metadata.version);
    const header =
      `# ${parsed.metadata.title}\n` +
      `#\n` +
      `# ${parsed.metadata.summary.replace(/\n/g, '\n# ')}\n` +
      `#\n` +
      `# Reviewed by a human before \`approval: approved\` is set. Approval is what\n` +
      `# permits unattended replay of any step marked risk: irreversible.\n` +
      `#\n` +
      `# Values below are parameter REFERENCES ({{name}}), never captured data.\n\n`;
    writeFileSync(path, header + stringifyYaml(parsed, { lineWidth: 100 }), 'utf8');
    return path;
  }

  /** Accepts `name`, `name@version`, or a file path. */
  load(ref: string): Capability {
    const path = this.resolvePath(ref);
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    return CapabilitySchema.parse(raw);
  }

  resolvePath(ref: string): string {
    if (ref.endsWith('.yaml') || ref.endsWith('.yml')) {
      if (!existsSync(ref)) throw new Error(`Capability file not found: ${ref}`);
      return ref;
    }
    if (ref.includes('@')) {
      const [name, version] = ref.split('@');
      const p = this.fileFor(name!, version!);
      if (!existsSync(p)) throw new Error(`Capability not found: ${ref}`);
      return p;
    }
    const versions = this.versionsOf(ref);
    if (versions.length === 0) {
      const known = this.list()
        .map((c) => capabilityRef(c))
        .join(', ');
      throw new Error(`Capability "${ref}" not found. Available: ${known || '(none saved yet)'}`);
    }
    return this.fileFor(ref, versions[versions.length - 1]!);
  }

  /** Semver-sorted ascending, so the last entry is the newest. */
  versionsOf(name: string): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(`${name}@`) && f.endsWith('.yaml'))
      .map((f) => f.slice(name.length + 1, -'.yaml'.length))
      .sort(compareSemver);
  }

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    const out: Capability[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.yaml')) continue;
      try {
        out.push(CapabilitySchema.parse(parseYaml(readFileSync(join(this.dir, f), 'utf8'))));
      } catch {
        // A malformed file should not take down the whole catalog listing.
      }
    }
    return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || compareSemver(a.metadata.version, b.metadata.version));
  }

  /** Only the newest version of each capability — what the catalog advertises. */
  listLatest(): Capability[] {
    const byName = new Map<string, Capability>();
    for (const c of this.list()) byName.set(c.metadata.name, c);
    return [...byName.values()];
  }

  /** Integrity fingerprint of the spec, independent of metadata churn. */
  static specHash(capability: Capability): string {
    return createHash('sha256').update(JSON.stringify(capability.spec)).digest('hex').slice(0, 16);
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function bumpVersion(version: string, kind: 'major' | 'minor' | 'patch' = 'minor'): string {
  const [maj = 0, min = 0, pat = 0] = version.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}
