from fastapi import APIRouter, Depends, HTTPException
from app.db import get_supabase
from app.auth import get_current_user

router = APIRouter(prefix="/users/me", tags=["users"])


@router.get("/saved-cafes")
def get_saved_cafes(current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    res = (
        supabase.table("saved_cafes")
        .select("cafe_id, saved_at, cafes(*)")
        .eq("user_id", current_user["user_id"])
        .execute()
    )
    return res.data


@router.post("/saved-cafes/{cafe_id}", status_code=201)
def save_cafe(cafe_id: str, current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    # Check cafe exists
    cafe_res = supabase.table("cafes").select("id").eq("id", cafe_id).execute()
    if not cafe_res.data:
        raise HTTPException(status_code=404, detail="Cafe not found")

    supabase.table("saved_cafes").upsert(
        {"user_id": current_user["user_id"], "cafe_id": cafe_id}
    ).execute()
    return {"saved": True}


@router.delete("/saved-cafes/{cafe_id}", status_code=204)
def unsave_cafe(cafe_id: str, current_user: dict = Depends(get_current_user)):
    supabase = get_supabase()
    supabase.table("saved_cafes").delete().eq(
        "user_id", current_user["user_id"]
    ).eq("cafe_id", cafe_id).execute()
