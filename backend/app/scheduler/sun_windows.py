"""
Computes sun windows (5-minute resolution) for all cafes for a given date.

For each cafe:
  1. Load buildings from DB (synced weekly from Overpass)
  2. Filter nearby buildings (within ~150 m)
  3. For each 5-min slot, project building shadow polygons using pysolar
  4. Test if cafe point is inside any shadow polygon (shapely)
  5. Collapse boolean array → list of {start, end} sun intervals
"""

import asyncio
import json
import logging
import os
import warnings
from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime, timedelta, timezone
from math import tan, radians, cos, sin
from typing import Any

import httpx
from pysolar.solar import get_altitude, get_azimuth
from shapely.geometry import Point, Polygon, box as shapely_box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from app.db import get_pool, get_service_client

logger = logging.getLogger(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
COPENHAGEN_BBOX = {"south": 55.60, "west": 12.45, "north": 55.74, "east": 12.73}
EARTH_CIRC_M = 111_320
MIN_SUN_ALTITUDE_DEG = 1.0
MAX_SHADOW_LENGTH_M = 400.0
SLOT_MINUTES = 5
TZ = timezone(timedelta(hours=1))  # CET (approximate)
COPENHAGEN_CENTER = (55.6761, 12.5683)

# ---------------------------------------------------------------------------
# Worker process globals (populated by _worker_init)
# ---------------------------------------------------------------------------

_worker_buildings: list[dict] = []
_worker_tree: STRtree | None = None


def _worker_init(buildings: list[dict]) -> None:
    global _worker_buildings, _worker_tree
    _worker_buildings = buildings
    _worker_tree = _build_spatial_index(buildings)


def _worker_compute(args: tuple) -> dict:
    cafe, sun_slots, target_date_str = args
    intervals = compute_sun_window_for_cafe(
        cafe["lat"], cafe["lng"], _worker_buildings, _worker_tree, sun_slots,  # type: ignore[arg-type]
    )
    return {
        "cafe_id": cafe["id"],
        "cafe_name": cafe.get("name", cafe["id"]),
        "date": target_date_str,
        "intervals": intervals,
    }


# ---------------------------------------------------------------------------
# Overpass helpers
# ---------------------------------------------------------------------------

async def _overpass_post(query: str, timeout: int = 60) -> list[dict]:
    """POST to Overpass with 3 retries. Returns elements list or [] on failure."""
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.post(OVERPASS_URL, data={"data": query})
                res.raise_for_status()
                return res.json().get("elements", [])
        except (httpx.HTTPStatusError, httpx.TimeoutException) as e:
            if attempt == 2:
                logger.warning(f"Overpass unavailable after 3 attempts ({e}), skipping")
                return []
            wait = 10 * (attempt + 1)
            logger.warning(f"Overpass error ({e}), retrying in {wait}s...")
            await asyncio.sleep(wait)
    return []


def _resolve_height(tags: dict) -> float:
    if "height" in tags:
        try:
            return float(tags["height"].split()[0])
        except ValueError:
            pass
    if "building:levels" in tags:
        try:
            return float(tags["building:levels"]) * 3.0
        except ValueError:
            pass
    return 10.0


# ---------------------------------------------------------------------------
# Sync buildings from Overpass → DB (run weekly)
# ---------------------------------------------------------------------------

async def sync_buildings_from_overpass() -> None:
    """Fetch building footprints from Overpass and store in the buildings table."""
    b = COPENHAGEN_BBOX
    query = f"""
[out:json][timeout:60];
way["building"]({b['south']},{b['west']},{b['north']},{b['east']});
out geom tags;
"""
    logger.info("Syncing buildings from Overpass...")
    elements = await _overpass_post(query, timeout=90)
    if not elements:
        logger.warning("No buildings fetched — DB unchanged")
        return

    rows = []
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        coords = [[n["lon"], n["lat"]] for n in el["geometry"]]
        if len(coords) < 3:
            continue
        tags = el.get("tags", {})
        rows.append({
            "id": f"way/{el['id']}",
            "coords": coords,
            "height_m": _resolve_height(tags),
        })

    supabase = get_service_client()
    for i in range(0, len(rows), 500):
        supabase.table("buildings").upsert(rows[i:i + 500]).execute()
    logger.info(f"Synced {len(rows)} buildings to DB")


# ---------------------------------------------------------------------------
# Load buildings from DB
# ---------------------------------------------------------------------------

async def load_buildings_from_db() -> list[dict]:
    """Load all buildings from DB with pagination (PostgREST default limit is 1000 rows)."""
    supabase = get_service_client()
    buildings = []
    page_size = 1000
    offset = 0

    while True:
        res = (
            supabase.table("buildings")
            .select("coords, height_m")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = res.data
        for row in rows:
            coords = row["coords"]
            if isinstance(coords, str):
                coords = json.loads(coords)
            buildings.append({"coords": [tuple(c) for c in coords], "height_m": row["height_m"]})
        if len(rows) < page_size:
            break
        offset += page_size

    logger.info(f"Loaded {len(buildings)} buildings from DB")
    return buildings


# ---------------------------------------------------------------------------
# Shadow projection
# ---------------------------------------------------------------------------

def _metres_to_deg(dx_m: float, dy_m: float, ref_lat: float) -> tuple[float, float]:
    d_lat = dy_m / EARTH_CIRC_M
    d_lon = dx_m / (EARTH_CIRC_M * cos(radians(ref_lat)))
    return d_lon, d_lat


def project_shadow(building_coords: list[tuple], height_m: float,
                   sun_alt_deg: float, sun_az_deg: float,
                   ref_lat: float) -> Polygon | None:
    if sun_alt_deg < MIN_SUN_ALTITUDE_DEG:
        return None
    shadow_len = min(height_m / tan(radians(sun_alt_deg)), MAX_SHADOW_LENGTH_M)
    az_rad = radians(sun_az_deg)
    dx_m = -shadow_len * sin(az_rad)
    dy_m = -shadow_len * cos(az_rad)
    d_lon, d_lat = _metres_to_deg(dx_m, dy_m, ref_lat)
    projected = [(lon + d_lon, lat + d_lat) for lon, lat in building_coords]
    try:
        return Polygon(building_coords + projected).convex_hull
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Sun slot precomputation (once per day, shared across all cafes)
# ---------------------------------------------------------------------------

def _precompute_sun_slots(target_date: date) -> list[tuple[int, float, float]]:
    """Return (slot_idx, altitude_deg, azimuth_deg) for every slot where sun is up.

    Uses Copenhagen city center — variation across the city is < 0.1°, negligible
    for shadow direction purposes.
    """
    lat, lng = COPENHAGEN_CENTER
    total_slots = (24 * 60) // SLOT_MINUTES
    slots = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for slot in range(total_slots):
            minutes = slot * SLOT_MINUTES
            dt = datetime(target_date.year, target_date.month, target_date.day,
                          minutes // 60, minutes % 60, 0, tzinfo=TZ)
            alt = get_altitude(lat, lng, dt)
            if alt >= MIN_SUN_ALTITUDE_DEG:
                slots.append((slot, alt, get_azimuth(lat, lng, dt)))
    return slots


# ---------------------------------------------------------------------------
# Per-cafe sun window
# ---------------------------------------------------------------------------

def _build_spatial_index(buildings: list[dict]) -> STRtree:
    """Build an R-tree over building bounding boxes for fast proximity queries."""
    geoms = []
    for b in buildings:
        lons = [c[0] for c in b["coords"]]
        lats = [c[1] for c in b["coords"]]
        geoms.append(shapely_box(min(lons), min(lats), max(lons), max(lats)))
    return STRtree(geoms)


def _nearby_buildings(cafe_lat: float, cafe_lng: float,
                      buildings: list[dict], tree: STRtree) -> list[dict]:
    radius_lat = MAX_SHADOW_LENGTH_M / EARTH_CIRC_M
    radius_lng = MAX_SHADOW_LENGTH_M / (EARTH_CIRC_M * cos(radians(cafe_lat)))
    query_box = shapely_box(
        cafe_lng - radius_lng, cafe_lat - radius_lat,
        cafe_lng + radius_lng, cafe_lat + radius_lat,
    )
    return [buildings[i] for i in tree.query(query_box)]


def compute_sun_window_for_cafe(
    cafe_lat: float, cafe_lng: float,
    buildings: list[dict], tree: STRtree,
    sun_slots: list[tuple[int, float, float]],
) -> list[dict]:
    """sun_slots: list of (slot_idx, altitude_deg, azimuth_deg) precomputed for the day."""
    point = Point(cafe_lng, cafe_lat)
    nearby = _nearby_buildings(cafe_lat, cafe_lng, buildings, tree)
    total_slots = (24 * 60) // SLOT_MINUTES
    in_sun = [False] * total_slots

    sun_slot_set = {s[0] for s in sun_slots}
    for slot, sun_alt, sun_az in sun_slots:
        shadows = [
            s for b in nearby
            if (s := project_shadow(b["coords"], b["height_m"], sun_alt, sun_az, cafe_lat)) is not None
        ]
        if shadows:
            merged = unary_union(shadows)
            in_sun[slot] = not merged.contains(point)
        else:
            in_sun[slot] = True

    intervals = []
    start_slot = None
    for i, sunny in enumerate(in_sun):
        if sunny and start_slot is None:
            start_slot = i
        elif not sunny and start_slot is not None:
            intervals.append(_slot_range(start_slot, i))
            start_slot = None
    if start_slot is not None:
        intervals.append(_slot_range(start_slot, total_slots))
    return intervals


def _slot_range(start: int, end: int) -> dict:
    def fmt(slot: int) -> str:
        m = slot * SLOT_MINUTES
        return f"{m // 60:02d}:{m % 60:02d}"
    return {"start": fmt(start), "end": fmt(end)}


# ---------------------------------------------------------------------------
# Main entry: compute all cafes for a date (uses DB buildings)
# ---------------------------------------------------------------------------

async def compute_all_sun_windows(target_date: date | None = None) -> None:
    if target_date is None:
        from zoneinfo import ZoneInfo
        target_date = datetime.now(ZoneInfo("Europe/Copenhagen")).date()

    logger.info(f"=== Starting sun window computation for {target_date} ===")

    supabase = get_service_client()
    cafes: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        res = supabase.table("cafes").select("id, lat, lng, name").range(offset, offset + page_size - 1).execute()
        cafes.extend(res.data)
        if len(res.data) < page_size:
            break
        offset += page_size
    if not cafes:
        logger.warning("No cafes in DB — run cafe sync first")
        return
    logger.info(f"Loaded {len(cafes)} cafes from DB")

    buildings = await load_buildings_from_db()
    if not buildings:
        logger.warning("No buildings in DB — run building sync first")
        return

    logger.info("Pre-computing sun angles for the day...")
    sun_slots = _precompute_sun_slots(target_date)
    logger.info(f"{len(sun_slots)} slots with sun above horizon")

    n_workers = max(1, (os.cpu_count() or 2))
    logger.info(f"Computing with {n_workers} worker processes...")

    args = [(cafe, sun_slots, str(target_date)) for cafe in cafes]

    loop = asyncio.get_running_loop()
    results: list[dict] = []

    def run_pool() -> list[dict]:
        with ProcessPoolExecutor(
            max_workers=n_workers,
            initializer=_worker_init,
            initargs=(buildings,),
        ) as executor:
            out = []
            for i, r in enumerate(executor.map(_worker_compute, args, chunksize=5), 1):
                logger.info(f"[{i}/{len(cafes)}] {r['cafe_name']}")
                out.append(r)
            return out

    results = await loop.run_in_executor(None, run_pool)

    logger.info(f"Upserting {len(results)} sun windows to DB...")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO sun_windows (cafe_id, date, intervals, computed_at)
            VALUES ($1, $2, $3::jsonb, now())
            ON CONFLICT (cafe_id, date) DO UPDATE
              SET intervals = excluded.intervals,
                  computed_at = excluded.computed_at
            """,
            [(r["cafe_id"], target_date, json.dumps(r["intervals"])) for r in results],
        )
    logger.info(f"=== Done. Upserted sun windows for {len(results)} cafes ===")

