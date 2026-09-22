import sqlite3
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS


app = Flask(__name__)
CORS(app)

DB_PATH = "silent_soongsil.db"
KST = timezone(timedelta(hours=9))

QUIET_MAX_DB = 45.0
NORMAL_MAX_DB = 65.0


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                location_id TEXT NOT NULL,
                location_name TEXT NOT NULL,
                db REAL NOT NULL,
                lux REAL,
                temperature REAL,
                humidity REAL,
                recorded_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_location_time
            ON readings(location_id, recorded_at)
            """
        )


def get_status(db):
    if db < QUIET_MAX_DB:
        return "quiet"
    if db < NORMAL_MAX_DB:
        return "normal"
    return "loud"


def row_to_dict(row):
    result = dict(row)
    result["status"] = get_status(result["db"])
    return result


@app.route("/")
def home():
    return "ESP32 환경 모니터링 서버 정상 작동!"


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "server_time": datetime.now(KST).isoformat(),
        }
    )


@app.route("/api/readings", methods=["POST"])
def readings():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "JSON 데이터가 없습니다."}), 400

    required_fields = ["device_id", "location_id", "location_name", "db"]
    missing_fields = [field for field in required_fields if field not in data]
    if missing_fields:
        return jsonify(
            {
                "error": "필수 항목이 없습니다.",
                "missing": missing_fields,
            }
        ), 400

    try:
        db_value = float(data["db"])
    except (TypeError, ValueError):
        return jsonify({"error": "db는 숫자여야 합니다."}), 400

    recorded_at = data.get(
        "recorded_at", datetime.now(KST).isoformat(timespec="seconds")
    )

    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO readings (
                device_id, location_id, location_name, db,
                lux, temperature, humidity, recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["device_id"],
                data["location_id"],
                data["location_name"],
                round(db_value, 1),
                data.get("lux"),
                data.get("temperature"),
                data.get("humidity"),
                recorded_at,
            ),
        )
        saved = conn.execute(
            "SELECT * FROM readings WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()

    print("저장된 데이터:", dict(saved))
    return jsonify(row_to_dict(saved)), 201


@app.route("/api/locations", methods=["GET"])
def locations():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT r.*
            FROM readings r
            INNER JOIN (
                SELECT location_id, MAX(id) AS latest_id
                FROM readings
                GROUP BY location_id
            ) latest ON r.id = latest.latest_id
            ORDER BY r.db ASC
            """
        ).fetchall()
    return jsonify([row_to_dict(row) for row in rows])


@app.route("/api/history/<location_id>", methods=["GET"])
def history(location_id):
    try:
        hours = int(request.args.get("hours", 12))
    except ValueError:
        hours = 12

    hours = max(1, min(hours, 168))
    cutoff = (datetime.now(KST) - timedelta(hours=hours)).isoformat(
        timespec="seconds"
    )

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM readings
            WHERE location_id = ? AND recorded_at >= ?
            ORDER BY recorded_at ASC
            """,
            (location_id, cutoff),
        ).fetchall()
    return jsonify([row_to_dict(row) for row in rows])


@app.route("/api/recommendation", methods=["GET"])
def recommendation():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT r.*
            FROM readings r
            INNER JOIN (
                SELECT location_id, MAX(id) AS latest_id
                FROM readings
                GROUP BY location_id
            ) latest ON r.id = latest.latest_id
            ORDER BY r.db ASC
            """
        ).fetchall()

    if not rows:
        return jsonify({"error": "최근 측정 데이터가 없습니다."}), 404

    latest_locations = [row_to_dict(row) for row in rows]
    best = min(latest_locations, key=lambda item: item["db"])
    return jsonify(
        {
            "location": best,
            "score": best["db"],
            "reason": (
                f"현재 {best['db']:.1f} dB로 측정된 공간 중 가장 조용합니다."
            ),
        }
    )


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
