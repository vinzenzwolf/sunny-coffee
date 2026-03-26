import asyncio
import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from app.scheduler.sun_windows import (
    compute_all_sun_windows,
    sync_cafes_from_overpass,
    sync_buildings_from_overpass,
)

logger = logging.getLogger(__name__)


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="Europe/Copenhagen")

    # Sync buildings from Overpass every Monday at 00:00 CET (buildings change rarely)
    scheduler.add_job(
        lambda: asyncio.create_task(sync_buildings_from_overpass()),
        CronTrigger(day_of_week="mon", hour=0, minute=0, timezone="Europe/Copenhagen"),
        id="sync_buildings",
        name="Sync buildings from Overpass",
        replace_existing=True,
    )

    # Sync cafes from Overpass every Monday at 00:30 CET (after buildings sync)
    scheduler.add_job(
        lambda: asyncio.create_task(sync_cafes_from_overpass()),
        CronTrigger(day_of_week="mon", hour=0, minute=30, timezone="Europe/Copenhagen"),
        id="sync_cafes",
        name="Sync cafes from Overpass",
        replace_existing=True,
    )

    # Compute sun windows every day at 02:00 CET (after cafe sync, uses DB buildings)
    scheduler.add_job(
        lambda: asyncio.create_task(compute_all_sun_windows()),
        CronTrigger(hour=2, minute=0, timezone="Europe/Copenhagen"),
        id="compute_sun_windows",
        name="Compute sun windows",
        replace_existing=True,
    )

    return scheduler
