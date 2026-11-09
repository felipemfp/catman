const nf = new Intl.NumberFormat('en-US');

/** The one score formatter: display, ghostStatus() and ui() all use it. */
export function formatScore(n: number): string {
  return nf.format(n);
}
