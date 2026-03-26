import asyncio
import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from app.scheduler.sun_windows import compute_all_sun_windows, sync_cafes_from_overpass

logger = logging.getLogger(__name__)


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="Europe/Copenhagen")

    # Sync cafes from Overpass every day at 01:00 CET
    scheduler.add_job(
        lambda: asyncio.create_task(sync_cafes_from_overpass()),
        CronTrigger(hour=1, minute=0, timezone="Europe/Copenhagen"),
        id="sync_cafes",
        name="Sync cafes from Overpass",
        replace_existing=True,
    )

    # Compute sun windows every day at 02:00 CET (after cafe sync)
    scheduler.add_job(
        lambda: asyncio.create_task(compute_all_sun_windows()),
        CronTrigger(hour=2, minute=0, timezone="Europe/Copenhagen"),
        id="compute_sun_windows",
        name="Compute sun windows",
        replace_existing=True,
    )

    return scheduler
