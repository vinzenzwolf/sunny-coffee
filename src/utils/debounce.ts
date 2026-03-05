/**
 * Creates a debounced version of `fn` that delays invocation until
 * `delayMs` milliseconds have passed since the last call.
 *
 * The returned function also exposes a `.cancel()` method to clear any
 * pending invocation.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): ((...args: T) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function debounced(...args: T): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  }

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
