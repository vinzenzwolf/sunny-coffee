import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from app.scheduler.sun_windows import compute_all_sun_windows

logger = logging.getLogger(__name__)


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="Europe/Copenhagen")

    # Compute sun windows every day at 02:00 CET
    scheduler.add_job(
        compute_all_sun_windows,
        CronTrigger(hour=2, minute=0, timezone="Europe/Copenhagen"),
        id="compute_sun_windows",
        name="Compute sun windows",
        replace_existing=True,
    )

    return scheduler
