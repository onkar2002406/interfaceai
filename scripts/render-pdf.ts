/**
 * Renders a Markdown file to PDF.
 *
 *   npx tsx scripts/render-pdf.ts DEMO-GUIDE.md
 *
 * Uses the Chromium that Playwright already installs, so this adds no toolchain
 * — no pandoc, no LaTeX, no headless-browser service. The point is that the PDF
 * is a build artifact of the Markdown rather than a hand-exported copy that
 * quietly drifts out of date the first time the guide is edited.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright';

const source = process.argv[2];
if (!source) {
  console.error('usage: npx tsx scripts/render-pdf.ts <file.md> [out.pdf]');
  process.exit(1);
}
const target = process.argv[3] ?? `${basename(source, extname(source))}.pdf`;

const body = await marked.parse(readFileSync(source, 'utf8'), { gfm: true });

// Print styling only. Screen-reading happens in the Markdown; this exists so the
// printed copy is legible — readable measure, tables that do not split across a
// page break, and code that wraps rather than being clipped at the margin.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${basename(source)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10.5pt/1.55 "Segoe UI", system-ui, sans-serif; color: #16191c; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4pt; letter-spacing: -.2pt; }
  h2 { font-size: 14pt; margin: 20pt 0 6pt; padding-bottom: 3pt;
       border-bottom: 1px solid #c9ced4; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 14pt 0 4pt; break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  ul, ol { padding-left: 18pt; }
  li { margin: 2pt 0; }
  code { font-family: "Cascadia Code", Consolas, monospace; font-size: 9pt;
         background: #f0f2f4; padding: 1pt 3pt; border-radius: 2pt; }
  pre { background: #f6f7f9; border: 1px solid #dde1e6; border-radius: 3pt;
        padding: 7pt 9pt; font-size: 8.6pt; line-height: 1.45;
        white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: inherit; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 6pt 0;
          break-inside: avoid; }
  th, td { border: 1px solid #c9ced4; padding: 4pt 6pt; text-align: left;
           vertical-align: top; }
  th { background: #eef0f3; font-weight: 600; }
  blockquote { margin: 6pt 0; padding: 4pt 0 4pt 10pt; border-left: 2.5pt solid #0b5c4a;
               color: #2b3138; break-inside: avoid; }
  blockquote p { margin: 3pt 0; }
  hr { border: 0; border-top: 1px solid #dde1e6; margin: 14pt 0; }
  a { color: #16191c; text-decoration: none; }
  strong { font-weight: 650; }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
const pdf = await page.pdf({
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="width:100%;font-size:7.5pt;color:#8a9199;padding:0 16mm;text-align:right;">' +
    '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '18mm', bottom: '14mm', left: '16mm', right: '16mm' },
});
await browser.close();

// Write the bytes ourselves rather than letting `page.pdf({ path })` do it, so a
// PDF viewer holding a lock on the old file is a message rather than a stack
// trace. Regenerating a guide you happen to have open is an ordinary thing to do.
try {
  writeFileSync(target, pdf);
  console.log(`${source} -> ${target}`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EBUSY' && (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  const fallback = `${basename(target, '.pdf')}.new.pdf`;
  writeFileSync(fallback, pdf);
  console.error(`${target} is open in another application, so it could not be replaced.`);
  console.error(`Wrote ${fallback} instead — close the viewer and rename it over the original.`);
  process.exitCode = 1;
}
