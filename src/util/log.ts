const useColor = process.stdout.isTTY;
const c = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const log = {
  info: (msg: string) => console.log(`${c(36, "•")} ${msg}`),
  ok: (msg: string) => console.log(`${c(32, "✓")} ${msg}`),
  warn: (msg: string) => console.warn(`${c(33, "!")} ${msg}`),
  error: (msg: string) => console.error(`${c(31, "✗")} ${msg}`),
  step: (msg: string) => console.log(`\n${c(35, "▶")} ${c(1, msg)}`),
  dim: (msg: string) => console.log(c(2, `  ${msg}`)),
  money: (msg: string) => console.log(`${c(33, "$")} ${msg}`),
};

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** transient failures worth re-sending; 400/INVALID_ARGUMENT/RAI blocks are not */
export function isRetryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /(?:^|[^0-9])(429|500|502|503|504)(?:[^0-9]|$)|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|overloaded|ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|fetch failed|network|socket hang up/i.test(msg);
}

export async function retry<T>(fn: () => Promise<T>, opts: { tries?: number; label?: string; retryAll?: boolean } = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === tries || (!opts.retryAll && !isRetryable(err))) break;
      const delay = 2000 * i + Math.floor(Math.random() * 1000);
      log.warn(`${opts.label ?? "call"} failed (attempt ${i}/${tries}), retrying in ${Math.round(delay / 1000)}s: ${(err as Error).message}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** minimal concurrency limiter — avoids a dependency for one function */
export function pLimit(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
