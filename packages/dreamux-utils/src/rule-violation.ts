/**
 * A domain rule said no.
 *
 * Defined in this package because the rule that raises it is checked on both
 * sides of the provider seam: the shared config validators
 * (`./config-validate.ts`) and each provider's own config reader reject a bad
 * value here, and the host's request readers must recognize exactly that class.
 * A provider depends on this package and never on the host, so the shared class
 * has to live below both.
 *
 * Deliberately *not* a host failure code: a rule is checked on more than one
 * kind of path, and only the caller's own request makes breaking it the
 * caller's fault. The reader that knows a value came from a caller re-types
 * exactly this class as a bad request; the same rule broken by persisted state
 * stays unclassified and loud, because nothing the caller can send would fix
 * it.
 *
 * It exists so a request reader can narrow to one named type instead of
 * catching everything a validator might throw. A `TypeError` raised inside a
 * validation path is not a rule violation, and reporting it as the caller's
 * mistake both misleads the caller and states, in a failure's own words, a next
 * step that would not help. Such a failure keeps its own message and is
 * reported as an internal failure instead. Throw it only for a value that was
 * checked and refused; never for an import, a file read, or a call into code
 * that failed on its own.
 */
export class RuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
