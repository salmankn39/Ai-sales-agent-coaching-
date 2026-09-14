/**
 * EVERY ROW, NOT THE FIRST THOUSAND.
 *
 * This project's PostgREST is configured with a hard row ceiling of 1000, and it
 * applies to every read - including reads that explicitly ask for more. A query
 * written as `.limit(6000)` returns 1000 rows and no error, no warning, and no
 * flag on the response. The caller sums what it got and shows the student a
 * number that is simply wrong.
 *
 * Found by load-testing a student with a year of data on 2026-08-13:
 *   - Today's card said 22 outreaches. The database said 43. The 30-day window
 *     held 1021 event rows and 21 of them, including most of today's, were
 *     dropped on the floor.
 *   - Their CRM board held 1306 leads and rendered 1000.
 *   - Pasting a list of names deduped against 1000 of those 1306 leads, so it
 *     added someone who was already on the board - the one thing that code
 *     exists to prevent.
 *
 * Every log a student taps writes a row, so a busy student crosses a thousand
 * rows in a month without doing anything unusual. The number is silently wrong
 * from that day on, which is the worst shape a bug about someone's own numbers
 * can take: it looks like it is working.
 *
 * ORDERING IS NOT OPTIONAL. Paging walks the result set by offset, so the query
 * must sort by something unique or rows shift between pages and come back twice
 * or not at all. Pass a query that ends in a deterministic order - in practice
 * that means an `.order("id")` tiebreaker after whatever you actually sort by.
 */

type Page<T> = { data: T[] | null; error: unknown };

export const PAGE_SIZE = 1000;

/**
 * Run `build` once per page until a short page comes back, and return everything.
 *
 * `build(from, to)` should apply `.range(from, to)` to an otherwise finished
 * query. A page that errors stops the walk and returns what was collected so far
 * rather than throwing, because a partial board still beats a blank one - the
 * failure is logged.
 *
 * `cap` is a backstop against a runaway walk, not a product decision. It sits far
 * above any real student's volume; if you ever hit it, the fix is a smaller date
 * window or an aggregate, not a bigger number here.
 */
export async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<Page<T>>,
  { pageSize = PAGE_SIZE, cap = 50000, label = "query" }: { pageSize?: number; cap?: number; label?: string } = {},
): Promise<T[]> {
  const out: T[] = [];
  while (out.length < cap) {
    const { data, error } = await build(out.length, out.length + pageSize - 1);
    if (error) {
      console.error(`[pageAll] ${label} failed at offset ${out.length}:`, error);
      break;
    }
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  if (out.length >= cap) console.error(`[pageAll] ${label} hit the ${cap}-row backstop - narrow the window`);
  return out;
}
