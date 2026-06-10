import hashlib
import os
import secrets
import sqlite3
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "sudoku.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS completions (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            difficulty TEXT NOT NULL,
            mode TEXT NOT NULL,
            seconds INTEGER NOT NULL,
            date TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_completions_user_date
            ON completions(user_id, date);
        """)


def _hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000).hex()


def _new_session(conn, user_id):
    token = secrets.token_hex(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
        (token, user_id, datetime.now().isoformat()),
    )
    return token


def register(username, password):
    """Returns (token, error)."""
    if not (2 <= len(username) <= 20):
        return None, "用户名需 2-20 个字符"
    if len(password) < 4:
        return None, "密码至少 4 位"
    salt = secrets.token_hex(16)
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
                (username, _hash_password(password, salt), salt, datetime.now().isoformat()),
            )
        except sqlite3.IntegrityError:
            return None, "用户名已被占用"
        return _new_session(conn, cur.lastrowid), None


def login(username, password):
    """Returns (token, error)."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row is None or not secrets.compare_digest(
            row["password_hash"], _hash_password(password, row["salt"])
        ):
            return None, "用户名或密码错误"
        return _new_session(conn, row["id"]), None


def logout(token):
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def get_user_by_token(token):
    """Returns {"id", "username"} or None."""
    if not token:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
            (token,),
        ).fetchone()
        return dict(row) if row else None


def record_completion(user_id, difficulty, mode, seconds):
    now = datetime.now()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO completions (user_id, difficulty, mode, seconds, date, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, difficulty, mode, seconds, now.strftime("%Y-%m-%d"), now.isoformat()),
        )


def total_completed(user_id):
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM completions WHERE user_id = ?", (user_id,)
        ).fetchone()[0]


def daily_stats(user_id, year, month):
    """Returns {"YYYY-MM-DD": {"count": n, "best": seconds}} for the month."""
    prefix = f"{year:04d}-{month:02d}-%"
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT date, COUNT(*) AS count, MIN(seconds) AS best"
            " FROM completions WHERE user_id = ? AND date LIKE ? GROUP BY date",
            (user_id, prefix),
        ).fetchall()
    return {r["date"]: {"count": r["count"], "best": r["best"]} for r in rows}
