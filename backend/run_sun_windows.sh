#!/usr/bin/env bash
# Run the sun window computation inside the Docker container,
# detached from the SSH session, with output saved to a log file.
#
# Usage (from the backend/ directory on the VPS):
#   ./run_sun_windows.sh
#
# The script will print the log file path and background PID, then exit.
# You can follow progress with:
#   tail -f <log-file>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="$LOG_DIR/sun_windows_${TIMESTAMP}.log"

# docker compose must be run from the directory that contains docker-compose.yml
cd "$SCRIPT_DIR"

echo "Starting sun window computation..."
echo "Log: $LOG_FILE"

# Copy the runner script into the container (needed if image predates this file)
CONTAINER_ID="$(docker compose ps -q api)"
docker cp "$SCRIPT_DIR/app/compute_now.py" "${CONTAINER_ID}:/app/app/compute_now.py"

nohup docker compose exec -T api python app/compute_now.py \
    > "$LOG_FILE" 2>&1 &

PID=$!
echo "PID: $PID"
echo ""
echo "Follow progress:  tail -f $LOG_FILE"
echo "Check if running: ps -p $PID"
