/**
 * The Lingui macro compiles away in the app build; tests run the source, so `t` just renders the
 * English template and `msg` keeps the source text as the descriptor.
 */
export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return String.raw(strings, ...values);
}

export function msg(strings: TemplateStringsArray, ...values: unknown[]) {
  const message = String.raw(strings, ...values);
  return { id: message, message };
}
