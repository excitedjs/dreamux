/**
 * Join concurrent calls of one async method on one instance.
 *
 * The Promise is the whole mechanism. `active` shares the running Promise and
 * releases it once the call settles, so the next caller starts a fresh
 * operation. `once` shares the running Promise and additionally retains the
 * first SUCCESSFUL one for the instance's lifetime, so a completed operation
 * answers later callers with its result; a rejected one is released, so a
 * failure stays retryable.
 *
 * Deliberately nothing else. It adds no lifecycle validation, no persistence,
 * no policy, and no error surface: an operation that needs those states them
 * itself. Arguments are not part of the key — joiners join the first call, and
 * keying on arguments would make this a registry rather than a join.
 */
export type DeduplicateKind = 'active' | 'once';

type AsyncMethod<This, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Promise<Result>;

export function deduplicate(options: { type: DeduplicateKind }) {
  return function decorate<This extends object, Args extends unknown[], Result>(
    method: AsyncMethod<This, Args, Result>,
    _context: ClassMethodDecoratorContext<
      This,
      AsyncMethod<This, Args, Result>
    >,
  ): AsyncMethod<This, Args, Result> {
    const running = new WeakMap<This, Promise<Result>>();
    const retained = new WeakMap<This, Promise<Result>>();
    return function deduplicated(this: This, ...args: Args): Promise<Result> {
      const kept = retained.get(this);
      if (kept !== undefined) return kept;
      const joined = running.get(this);
      if (joined !== undefined) return joined;
      let adopt!: (result: Promise<Result>) => void;
      const shared = new Promise<Result>((resolve) => {
        adopt = resolve;
      });
      // Published before the method is entered, so a call the method makes back
      // into itself joins this operation instead of starting a second one.
      running.set(this, shared);
      // Registered before the caller's own continuation, so a call made right
      // after this one settles never joins an operation that already ended.
      void shared.then(
        () => {
          if (running.get(this) === shared) running.delete(this);
          if (options.type === 'once') retained.set(this, shared);
        },
        () => {
          if (running.get(this) === shared) running.delete(this);
        },
      );
      try {
        adopt(method.apply(this, args));
      } catch (error) {
        // A method that throws before returning a Promise fails the same call
        // every joiner is already holding.
        adopt(Promise.reject(error));
      }
      return shared;
    };
  };
}
