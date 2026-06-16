/**
 * Feishu's documented hard limit for a card request body. Past this the API
 * rejects the call outright; the packer keeps each card's serialised content
 * below `CARD_CONTENT_SAFE_BYTES` so HTTP headers and the request envelope
 * still fit underneath the hard cap.
 */
export const FEISHU_CARD_REQUEST_LIMIT_BYTES = 30 * 1024
export const CARD_CONTENT_SAFE_BYTES = 28 * 1024

/**
 * v2 card per-card element-count cap. Observed in PR #73 review: a card with
 * 250 short markdown elements is rejected by Feishu, though the JSON itself
 * is well under the byte cap. The exact upper bound is not in the open docs;
 * the reviewer-cited 200 figure is treated as the hard limit and a lower
 * number is used as the safe budget.
 */
export const FEISHU_CARD_ELEMENT_HARD_CAP = 200
export const CARD_ELEMENT_SAFE_CAP = 180

/**
 * v2 table column cap from the Feishu card API. A wider table is split into
 * several adjacent table elements; each split half repeats the original first
 * column as an identifier the reader can still align rows against.
 */
export const TABLE_COLUMN_HARD_CAP = 50

/** In-card paginator page size for tables. The API caps this at 10. */
export const TABLE_DEFAULT_PAGE_SIZE = 10

/**
 * Per-cell byte cap. A cell larger than this is rejected at render time:
 * splitting one row's cell across multiple rows breaks alignment with the
 * other columns, and silently truncating drops the data the caller asked to
 * deliver. The author is expected to move the oversized content into a
 * paragraph or fenced code block.
 */
export const CELL_MAX_BYTES = 4 * 1024
