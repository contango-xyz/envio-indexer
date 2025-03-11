type DebouncedFunction<T extends (...args: any[]) => any> = {
  (...args: Parameters<T>): Promise<ReturnType<T>>;
  cancel: (key?: string) => void;
  cancelAll: () => void;
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): DebouncedFunction<T> {
  // Track state per key
  const states = new Map<string, {
    timeout: NodeJS.Timeout | null;
    pendingPromise: Promise<any> | null;
    pendingResolve: ((value: any) => void) | null;
  }>();

  const getState = (key: string) => {
    if (!states.has(key)) {
      states.set(key, {
        timeout: null,
        pendingPromise: null,
        pendingResolve: null
      });
    }
    return states.get(key)!;
  };

  const debouncedFn = (key: string, ...args: Parameters<T>): Promise<ReturnType<T>> => {
    const state = getState(key);

    // If we already have a pending promise for this key, return it
    if (state.pendingPromise) return state.pendingPromise;

    // Create a new promise
    state.pendingPromise = new Promise((resolve) => {
      state.pendingResolve = resolve;

      if (state.timeout) {
        clearTimeout(state.timeout);
      }

      state.timeout = setTimeout(async () => {
        const result = await func.apply(null, args);
        if (state.pendingResolve) {
          state.pendingResolve(result);
        }
        // Reset state
        state.pendingPromise = null;
        state.pendingResolve = null;
        state.timeout = null;
      }, wait);
    });

    return state.pendingPromise;
  };

  // Cancel specific key's debounce
  debouncedFn.cancel = (key?: string) => {
    if (key) {
      const state = states.get(key);
      if (state) {
        if (state.timeout) {
          clearTimeout(state.timeout);
          state.timeout = null;
        }
        state.pendingPromise = null;
        state.pendingResolve = null;
        states.delete(key);
      }
    }
  };

  // Cancel all debounces
  debouncedFn.cancelAll = () => {
    for (const [key] of states) {
      debouncedFn.cancel(key);
    }
  };

  return debouncedFn as unknown as DebouncedFunction<T>;
} 