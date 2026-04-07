# Opening Hours Schema — Design

## Storage

Replace the `cafe_hours` table and the `opening_hours text` column on `cafes` with a single JSON column:

```sql
ALTER TABLE public.cafes ADD COLUMN opening_hours jsonb;
DROP TABLE public.cafe_hours;
```

`opening_hours` is `null` when no data is available. Otherwise it is a JSON object with keys `mo tu we th fr sa su`, each holding `{ open, close }` strings.

---

## Format

```json
{
  "mo": { "open": "09:00", "close": "18:00" },
  "tu": { "open": "09:00", "close": "18:00" },
  "we": { "open": "00:00", "close": "00:00" },
  "th": { "open": "09:00", "close": "18:00" },
  "fr": { "open": "24:00", "close": "24:00" },
  "sa": { "open": "11:00", "close": "24:00" },
  "su": { "open": "11:00", "close": "18:00" }
}
```

### Special values

| Situation | Representation |
|---|---|
| No hours data | `null` (column is null — no entry) |
| Closed that day | `{ "open": "00:00", "close": "00:00" }` |
| Open 24/7 | All 7 days: `{ "open": "00:00", "close": "24:00" }` |
| Closes at midnight | `close: "24:00"` |

---

## App-side changes

### `CafeMetadata.openingHours`
Keep as `string | undefined` but change the format from OSM style to a serialized JSON string, **or** change the type to the parsed object — whichever is cleaner. Simplest: store it as the raw JSON string and parse on use.

### `cafe-repository.ts`
- SELECT `opening_hours` (jsonb) from `cafes`
- Pass it directly into `CafeMetadata.openingHours` (stringify if keeping string type)
- Remove the `cafe_hours` query entirely
- Bump cache to `cafes_cache_v2`

### `opening-hours.ts` — `getOpenUntilToday()`
```
1. If openingHours is null → return { isOpen: false }

2. Get today's key: "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su"

3. Look up today's entry. If missing → return { isOpen: false }

4. open == "00:00" && close == "00:00" → return { isOpen: false }  // closed today

5. open == "00:00" && close == "24:00" → return { isOpen: true }    // 24/7

6. Parse open/close as minutes. If currentMinute in [open, close) →
   return { isOpen: true, closesAt: close }

7. → return { isOpen: false }
```

---

## Migration from `cafe_hours`

```sql
UPDATE cafes c
SET opening_hours = (
  SELECT jsonb_object_agg(
    LOWER(LEFT(day, 2)),   -- 'monday' → 'mo', etc.
    jsonb_build_object('open', open, 'close', close)
  )
  FROM cafe_hours h
  WHERE h.cafe_id = c.id
)
WHERE EXISTS (SELECT 1 FROM cafe_hours h WHERE h.cafe_id = c.id);
```

After verifying, drop the old table.
