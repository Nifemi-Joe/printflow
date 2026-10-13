/**
 * Development console: prints links and codes to the terminal as a readable box,
 * so you can test sign-up, verification, sign-in and checkout without a real
 * email account, phone or authenticator.
 *
 * Only the development drivers (LOG email, LOG SMS) and API code guarded by
 * DEV_CONSOLE call this. Configuration refuses both in production.
 */

const useColour = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, s: string): string {
  return useColour() ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export interface DevConsoleLine {
  label: string;
  value: string;
}

/** Formats a block like:
 *  ┌─ PrintFlow dev ─ SMS code ─────────────┐
 *  │ To      +2348012345678                 │
 *  │ Code    123456                         │
 *  └────────────────────────────────────────┘
 */
export function formatDevBlock(title: string, lines: DevConsoleLine[], colour = false): string {
  const labelWidth = Math.max(0, ...lines.map((l) => l.label.length));
  const rows = lines.map((l) => (l.label ? `${l.label.padEnd(labelWidth)}  ${l.value}` : l.value));
  const heading = ` PrintFlow dev ─ ${title} `;
  const width = Math.max(heading.length + 2, ...rows.map((r) => r.length + 2), 44);
  const c = (code: string, s: string) => (colour ? `\u001b[${code}m${s}\u001b[0m` : s);
  const top = `┌─${c("1;32", heading)}${"─".repeat(Math.max(0, width - heading.length - 1))}┐`;
  const body = rows.map((r) => `│ ${r}${" ".repeat(Math.max(0, width - r.length - 1))}│`);
  const bottom = `└${"─".repeat(width)}┘`;
  return [top, ...body, bottom].join("\n");
}

export function devConsole(title: string, lines: DevConsoleLine[]): void {
  process.stdout.write(`\n${formatDevBlock(title, lines, useColour())}\n\n`);
}

/** Every http(s) link in a piece of text, in order. */
export function extractLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => m[0]);
}

/** The first standalone 6-digit code in a piece of text. */
export function extractCode(text: string): string | null {
  return /\b(\d{6})\b/.exec(text)?.[1] ?? null;
}

export { paint };
