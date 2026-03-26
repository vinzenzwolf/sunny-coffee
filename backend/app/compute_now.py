"""
Standalone runner: compute sun windows for all cafes immediately.
Run inside the Docker container:
    python app/compute_now.py
"""

import asyncio
import logging
import sys

from app.db import close_pool
from app.scheduler.sun_windows import compute_all_sun_windows

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def main():
    logger.info("=== compute_now: starting sun window computation ===")
    try:
        await compute_all_sun_windows()
        logger.info("=== compute_now: done ===")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
