/**
 * Unordered bounded-concurrency map: run `task` over `items` with at most `concurrency` in flight,
 * each worker pulling the next item as soon as it finishes. Results are returned in input order.
 *
 * Unlike a sliding-window pipeline (which awaits results strictly in array order so a slow early
 * item stalls scheduling of later ones), this pool has no head-of-line blocking: fast tasks
 * immediately fill the slots freed by others. Use it for pure fan-out where nothing needs to be
 * consumed in order — only aggregated once all settle (e.g. the audit per-seed evaluation).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  onSettled?: (result: R, item: T, completed: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) {
    return results;
  }

  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
  let nextIndex = 0;
  let completed = 0;

  // `nextIndex++` / `completed++` are atomic between awaits on JS's single-threaded loop.
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= total) {
        return;
      }
      const result = await task(items[index], index);
      results[index] = result;
      completed++;
      onSettled?.(result, items[index], completed, total);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return results;
}
