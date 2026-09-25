/**
 * Join concurrent calls of one async method on one instance, and retain the
 * first SUCCESSFUL call for the instance's lifetime.
 *
 * One WeakMap entry is the whole mechanism: publishing it joins every caller
 * (in flight or, once settled, already succeeded) onto the same Promise, and
 * only a failure clears the entry, so a completed operation answers later
 * callers with its result while a rejected one stays retryable.
 *
 * Deliberately nothing else. It adds no lifecycle validation, no persistence,
 * no policy, and no error surface: an operation that needs those states them
 * itself. Arguments are not part of the key — joiners join the first call, and
 * keying on arguments would make this a registry rather than a join.
 */
type AsyncMethod<This, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Promise<Result>;

export function deduplicate<
  This extends object,
  Args extends unknown[],
  Result,
>(
  method: AsyncMethod<This, Args, Result>,
  _context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Result>>,
): AsyncMethod<This, Args, Result> {
  const state = new WeakMap<This, Promise<Result>>();
  return function deduplicated(this: This, ...args: Args): Promise<Result> {
    const existing = state.get(this);
    if (existing !== undefined) return existing;
    let adopt!: (result: Promise<Result>) => void;
    const shared = new Promise<Result>((resolve) => {
      adopt = resolve;
    });
    // Published before the method is entered, so a call the method makes back
    // into itself joins this operation instead of starting a second one.
    state.set(this, shared);
    // Registered before the caller's own continuation, so a call made right
    // after this one fails never joins an operation that already ended. A
    // success leaves the entry in place — that is the retention.
    void shared.then(undefined, () => {
      if (state.get(this) === shared) state.delete(this);
    });
    try {
      adopt(method.apply(this, args));
    } catch (error) {
      // A method that throws before returning a Promise fails the same call
      // every joiner is already holding.
      adopt(Promise.reject(error));
    }
    return shared;
  };
}
