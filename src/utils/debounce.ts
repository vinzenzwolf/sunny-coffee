/**
 * Creates a throttled version of `fn` that fires at most once per `limitMs`.
 * The first call fires immediately; subsequent calls within the window are
 * held and flushed once the window expires.
 *
 * The returned function also exposes a `.cancel()` method to clear any
 * pending invocation.
 */
export function throttle<T extends unknown[]>(
  fn: (...args: T) => void,
  limitMs: number,
): ((...args: T) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;

  function throttled(...args: T): void {
    if (timer === null) {
      fn(...args);
      timer = setTimeout(() => {
        timer = null;
        if (lastArgs !== null) {
          const pending = lastArgs;
          lastArgs = null;
          throttled(...pending);
        }
      }, limitMs);
    } else {
      lastArgs = args;
    }
  }

  throttled.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  return throttled;
}

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
