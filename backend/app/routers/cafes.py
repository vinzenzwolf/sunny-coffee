from datetime import date as DateType
from fastapi import APIRouter, HTTPException
from app.db import get_supabase

router = APIRouter(prefix="/cafes", tags=["cafes"])


@router.get("")
def list_cafes(date: DateType | None = None):
    """Return all cafes with today's sun windows joined."""
    supabase = get_supabase()
    query_date = str(date) if date else str(DateType.today())

    # Fetch cafes
    cafes_res = supabase.table("cafes").select("*").execute()
    cafes = {c["id"]: c for c in cafes_res.data}

    # Fetch sun windows for that date
    sw_res = (
        supabase.table("sun_windows")
        .select("cafe_id, intervals")
        .eq("date", query_date)
        .execute()
    )
    for sw in sw_res.data:
        if sw["cafe_id"] in cafes:
            cafes[sw["cafe_id"]]["sun_windows"] = sw["intervals"]

    return list(cafes.values())


@router.get("/{cafe_id}")
def get_cafe(cafe_id: str, date: DateType | None = None):
    """Return a single cafe with its sun window for the given date."""
    supabase = get_supabase()
    query_date = str(date) if date else str(DateType.today())

    cafe_res = supabase.table("cafes").select("*").eq("id", cafe_id).single().execute()
    if not cafe_res.data:
        raise HTTPException(status_code=404, detail="Cafe not found")

    cafe = cafe_res.data
    sw_res = (
        supabase.table("sun_windows")
        .select("intervals")
        .eq("cafe_id", cafe_id)
        .eq("date", query_date)
        .execute()
    )
    cafe["sun_windows"] = sw_res.data[0]["intervals"] if sw_res.data else []
    return cafe
