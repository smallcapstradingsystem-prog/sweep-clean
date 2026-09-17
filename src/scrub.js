/**
 * scrub.js — Secret scrubbing for log lines and error messages.
 *
 * Ethers v6 (and some RPC providers) embed the offending argument in
 * their error messages. When that argument is a private key or a
 * BIP-39 mnemonic, the raw value ends up in logs, the on-screen run
 * log, and telemetry. This strips both shapes before anything is
 * displayed or reported.
 *
 * Patterns:
 *   - 12+ consecutive lowercase words  → BIP-39 phrase shape
 *     (optionally prefixed with `0x`, which some error formatters add)
 *   - 0x + 64 hex characters           → private key
 *
 * Note: we deliberately do NOT require a leading `\b` before the
 * mnemonic match. Ethers errors format the offending value as
 * `value="0xabandon abandon ... abandon about"`, and there is no word
 * boundary between the `x` in `0x` and the first `a` in `abandon`
 * (both are word characters). Requiring a `\b` there causes the
 * regex to miss the exact case we most need to catch.
 *
 * The trade-off is that a rare false positive is possible — a string
 * with 12+ consecutive lowercase 3+ char words that isn't actually a
 * mnemonic gets redacted. That's acceptable: over-redaction is safe,
 * under-redaction leaks secrets.
 */

export function scrubSecret(text) {
  const s = String(text ?? '');
  return s
    .replace(/(?:0x)?([a-z]{3,}\s+){11,}[a-z]{3,}\b/g, '[REDACTED-MNEMONIC]')
    .replace(/0x[a-fA-F0-9]{64}/g, '0x[REDACTED-KEY]');
}