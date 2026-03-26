from fastapi import APIRouter
from app.db import get_supabase

router = APIRouter(prefix="/buildings", tags=["buildings"])


@router.get("")
def list_buildings():
    """Return all building footprints used for shadow computation."""
    supabase = get_supabase()
    res = supabase.table("buildings").select("id, coords, height_m").execute()
    return res.data
