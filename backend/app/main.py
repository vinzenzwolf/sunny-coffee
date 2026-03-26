import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import close_pool
from app.routers import cafes, users, buildings
from app.scheduler.runner import create_scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = create_scheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.start()
    logger.info("Scheduler started")
    yield
    scheduler.shutdown()
    await close_pool()


app = FastAPI(title="Sunny Coffee API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(cafes.router)
app.include_router(users.router)
app.include_router(buildings.router)


@app.get("/health")
def health():
    return {"status": "ok"}
