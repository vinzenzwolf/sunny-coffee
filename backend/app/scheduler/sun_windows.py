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
from datetime import date, datetime, timedelta, timezone
from math import tan, radians, cos, sin
from typing import Any

import httpx
from pysolar.solar import get_altitude, get_azimuth
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from app.db import get_pool, get_service_client

logger = logging.getLogger(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
COPENHAGEN_BBOX = {"south": 55.60, "west": 12.45, "north": 55.74, "east": 12.73}
EARTH_CIRC_M = 111_320
MIN_SUN_ALTITUDE_DEG = 1.0
MAX_SHADOW_LENGTH_M = 400.0
SLOT_MINUTES = 5
TZ = timezone(timedelta(hours=1))  # CET (approximate)


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
    """Load all buildings from the DB. Returns list of {coords, height_m}."""
    supabase = get_service_client()
    res = supabase.table("buildings").select("coords, height_m").execute()
    buildings = []
    for row in res.data:
        coords = row["coords"]
        # coords stored as JSON array of [lon, lat] pairs
        if isinstance(coords, str):
            coords = json.loads(coords)
        buildings.append({"coords": [tuple(c) for c in coords], "height_m": row["height_m"]})
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
# Per-cafe sun window
# ---------------------------------------------------------------------------

def _nearby_buildings(cafe_lat: float, cafe_lng: float,
                      buildings: list[dict]) -> list[dict]:
    # Radius must cover MAX_SHADOW_LENGTH_M (400m) in all directions so that
    # buildings casting long shadows at low sun angles are not excluded.
    # 400m in degrees: ~0.0036 lat, ~0.0065 lon at Copenhagen (lat 55.6°)
    radius_lat = MAX_SHADOW_LENGTH_M / EARTH_CIRC_M          # ~0.0036°
    radius_lng = MAX_SHADOW_LENGTH_M / (EARTH_CIRC_M * cos(radians(cafe_lat)))  # ~0.0064°
    return [
        b for b in buildings
        if any(
            abs(lon - cafe_lng) < radius_lng and abs(lat - cafe_lat) < radius_lat
            for lon, lat in b["coords"]
        )
    ]


def compute_sun_window_for_cafe(
    cafe_lat: float, cafe_lng: float,
    buildings: list[dict], target_date: date,
) -> list[dict]:
    point = Point(cafe_lng, cafe_lat)
    nearby = _nearby_buildings(cafe_lat, cafe_lng, buildings)
    total_slots = (24 * 60) // SLOT_MINUTES
    in_sun = []

    for slot in range(total_slots):
        minutes = slot * SLOT_MINUTES
        dt = datetime(
            target_date.year, target_date.month, target_date.day,
            minutes // 60, minutes % 60, 0,
            tzinfo=TZ,
        )
        sun_alt = get_altitude(cafe_lat, cafe_lng, dt)
        if sun_alt < MIN_SUN_ALTITUDE_DEG:
            in_sun.append(False)
            continue
        sun_az = get_azimuth(cafe_lat, cafe_lng, dt)
        shadows = [
            s for b in nearby
            if (s := project_shadow(b["coords"], b["height_m"], sun_alt, sun_az, cafe_lat)) is not None
        ]
        if shadows:
            merged = unary_union(shadows)
            in_sun.append(not merged.contains(point))
        else:
            in_sun.append(True)

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
        target_date = date.today()

    logger.info(f"=== Starting sun window computation for {target_date} ===")

    supabase = get_service_client()
    cafes_res = supabase.table("cafes").select("id, lat, lng").execute()
    cafes: list[dict] = cafes_res.data
    if not cafes:
        logger.warning("No cafes in DB — run cafe sync first")
        return
    logger.info(f"Loaded {len(cafes)} cafes from DB")

    buildings = await load_buildings_from_db()
    if not buildings:
        logger.warning("No buildings in DB — run building sync first")
        return

    completed = 0

    async def process(cafe: dict[str, Any]) -> dict:
        nonlocal completed
        intervals = await asyncio.to_thread(
            compute_sun_window_for_cafe,
            cafe["lat"], cafe["lng"], buildings, target_date,
        )
        completed += 1
        if completed % 50 == 0 or completed == len(cafes):
            logger.info(f"Progress: {completed}/{len(cafes)} cafes computed")
        return {"cafe_id": cafe["id"], "date": str(target_date), "intervals": intervals}

    logger.info(f"Computing {(24 * 60) // SLOT_MINUTES} time slots per cafe...")
    results = await asyncio.gather(*[process(c) for c in cafes])

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


# ---------------------------------------------------------------------------
# One-off: sync cafes from Overpass → DB
# ---------------------------------------------------------------------------

async def sync_cafes_from_overpass() -> None:
    b = COPENHAGEN_BBOX
    query = f"""
[out:json][timeout:25];
(
  node["amenity"="cafe"]({b['south']},{b['west']},{b['north']},{b['east']});
  way["amenity"="cafe"]({b['south']},{b['west']},{b['north']},{b['east']});
  relation["amenity"="cafe"]({b['south']},{b['west']},{b['north']},{b['east']});
);
out center tags;
"""
    elements = await _overpass_post(query)
    if not elements:
        logger.warning("No cafes fetched from Overpass")
        return

    rows = []
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lng = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lng is None:
            continue
        tags = el.get("tags", {})
        rows.append({
            "id": f"{el['type']}/{el['id']}",
            "name": tags.get("name", "Cafe"),
            "lat": lat,
            "lng": lng,
            "area": (tags.get("addr:suburb") or tags.get("addr:neighbourhood") or
                     tags.get("addr:city_district") or tags.get("addr:city")),
            "opening_hours": tags.get("opening_hours") or tags.get("contact:opening_hours"),
            "cuisine": tags.get("cuisine"),
            "website": tags.get("website") or tags.get("contact:website"),
        })

    supabase = get_service_client()
    for i in range(0, len(rows), 500):
        supabase.table("cafes").upsert(rows[i:i + 500]).execute()
    logger.info(f"Synced {len(rows)} cafes to DB")
