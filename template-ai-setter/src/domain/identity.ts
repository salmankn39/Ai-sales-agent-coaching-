/** GENERATED from domain/spec — do not edit. Run `node domain/codegen/generate.mjs`. */

/** Normalize an IG handle: trim, strip ALL leading '@', trim, lowercase. Empty -> null.
 *  MUST stay byte-identical to domain/generated/identity.py (handle-parity test enforces). */
export function normalizeHandle(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.trim().replace(/^@+/, "").trim().toLowerCase();
  return h.length > 0 ? h : null;
}
