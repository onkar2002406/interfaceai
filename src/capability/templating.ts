/**
 * The only templating this system allows: `{{name}}` -> a supplied argument.
 *
 * It lives in its own module rather than in the capability schema because two
 * layers need it and they must not import each other — the schema describes
 * *what* a capability may say, and the element descriptor describes *which
 * control* a step means. Both are parameterised by the same syntax, and a
 * reviewer should only ever have to learn one.
 *
 * Deliberately not a template language. No expressions, no filters, no
 * conditionals: a capability artifact is a document a human approves, and
 * anything with control flow in it stops being reviewable at a glance.
 */

const REF = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitutes supplied arguments into a template.
 *
 * An unresolved reference is left INTACT rather than replaced with an empty
 * string. That matters: a step that types nothing, or a descriptor that matches
 * the first row of a table, is a silent wrong answer, whereas a literal
 * `{{shareId}}` surfaces immediately as a validation problem or a resolution
 * failure that names exactly what it went looking for.
 */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(REF, (whole, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) return whole;
    return String(v);
  });
}

/** Names of the parameters a template string references. Used to validate inputs. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(REF)].map((m) => m[1]!);
}
