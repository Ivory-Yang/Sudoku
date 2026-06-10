import asyncio
import json
import random
import string
import time
import uuid

from fastapi import FastAPI, Header, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import sudoku

app = FastAPI()
db.init_db()

games = {}   # game_id -> {"puzzle", "solution", "difficulty", "user_id", "started_at", "recorded"}
rooms = {}   # room_code -> Room


def auth_user(authorization):
    if authorization and authorization.startswith("Bearer "):
        return db.get_user_by_token(authorization[7:])
    return None


class AuthRequest(BaseModel):
    username: str
    password: str


class NewGameRequest(BaseModel):
    difficulty: str = "medium"


class CheckRequest(BaseModel):
    game_id: str
    board: list


@app.post("/api/register")
def api_register(req: AuthRequest):
    token, err = db.register(req.username.strip(), req.password)
    if err:
        return {"error": err}
    return {"token": token, "username": req.username.strip()}


@app.post("/api/login")
def api_login(req: AuthRequest):
    token, err = db.login(req.username.strip(), req.password)
    if err:
        return {"error": err}
    return {"token": token, "username": req.username.strip()}


@app.post("/api/logout")
def api_logout(authorization: str | None = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        db.logout(authorization[7:])
    return {"ok": True}


@app.get("/api/me")
def api_me(authorization: str | None = Header(default=None)):
    user = auth_user(authorization)
    if user is None:
        return {"error": "未登录"}
    return {"username": user["username"], "total_completed": db.total_completed(user["id"])}


@app.get("/api/stats/daily")
def api_daily_stats(year: int, month: int, authorization: str | None = Header(default=None)):
    user = auth_user(authorization)
    if user is None:
        return {"error": "未登录"}
    return {"days": db.daily_stats(user["id"], year, month)}


@app.post("/api/new-game")
def new_game(req: NewGameRequest, authorization: str | None = Header(default=None)):
    user = auth_user(authorization)
    puzzle, solution = sudoku.generate_puzzle(req.difficulty)
    game_id = str(uuid.uuid4())
    games[game_id] = {
        "puzzle": puzzle,
        "solution": solution,
        "difficulty": req.difficulty,
        "user_id": user["id"] if user else None,
        "started_at": time.time(),
        "recorded": False,
    }
    return {"game_id": game_id, "puzzle": puzzle}


@app.post("/api/check")
def check(req: CheckRequest):
    game = games.get(req.game_id)
    if game is None:
        return {"error": "game not found"}
    result = sudoku.check_board(game["puzzle"], game["solution"], req.board)
    if result["complete"] and not game["recorded"]:
        game["recorded"] = True
        result["seconds"] = int(time.time() - game["started_at"])
        if game["user_id"]:
            db.record_completion(game["user_id"], game["difficulty"], "single", result["seconds"])
    return result


# ---------- multiplayer ----------

class Room:
    def __init__(self, code, difficulty):
        self.code = code
        self.difficulty = difficulty
        self.puzzle = None
        self.solution = None
        self.players = {}  # player_id -> {"name", "ws", "user_id", "progress", "finished"}
        self.started = False
        self.started_at = None
        self.winner = None

    def state(self):
        return {
            "type": "room_state",
            "code": self.code,
            "difficulty": self.difficulty,
            "started": self.started,
            "winner": self.winner,
            "players": [
                {
                    "id": pid,
                    "name": p["name"],
                    "progress": p["progress"],
                    "finished": p["finished"],
                }
                for pid, p in self.players.items()
            ],
        }

    async def broadcast(self, message):
        data = json.dumps(message)
        for p in list(self.players.values()):
            try:
                await p["ws"].send_text(data)
            except Exception:
                pass


def make_room_code():
    while True:
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
        if code not in rooms:
            return code


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    player_id = str(uuid.uuid4())[:8]
    room = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            action = msg.get("action")

            if action == "create_room":
                user = db.get_user_by_token(msg.get("token"))
                code = make_room_code()
                room = Room(code, msg.get("difficulty", "medium"))
                room.players[player_id] = {
                    "name": msg.get("name", "玩家"), "ws": ws,
                    "user_id": user["id"] if user else None,
                    "progress": 0.0, "finished": False,
                }
                rooms[code] = room
                await ws.send_text(json.dumps({"type": "joined", "player_id": player_id, "code": code}))
                await room.broadcast(room.state())

            elif action == "join_room":
                code = msg.get("code", "").upper()
                room = rooms.get(code)
                if room is None or room.started:
                    await ws.send_text(json.dumps({"type": "error", "message": "房间不存在或已开始"}))
                    room = None
                    continue
                user = db.get_user_by_token(msg.get("token"))
                room.players[player_id] = {
                    "name": msg.get("name", "玩家"), "ws": ws,
                    "user_id": user["id"] if user else None,
                    "progress": 0.0, "finished": False,
                }
                await ws.send_text(json.dumps({"type": "joined", "player_id": player_id, "code": code}))
                await room.broadcast(room.state())

            elif action == "start_game" and room and not room.started:
                if len(room.players) < 2:
                    await ws.send_text(json.dumps({"type": "error", "message": "至少需要 2 名玩家"}))
                    continue
                puzzle, solution = await asyncio.to_thread(
                    sudoku.generate_puzzle, room.difficulty
                )
                room.puzzle, room.solution = puzzle, solution
                room.started = True
                room.started_at = time.time()
                await room.broadcast({"type": "game_start", "puzzle": room.puzzle})
                await room.broadcast(room.state())

            elif action == "update_board" and room and room.started and not room.winner:
                board = msg.get("board")
                prog = sudoku.progress(room.puzzle, room.solution, board)
                player = room.players[player_id]
                player["progress"] = prog
                if prog == 1.0 and not player["finished"]:
                    player["finished"] = True
                    room.winner = player["name"]
                    if player["user_id"]:
                        db.record_completion(
                            player["user_id"], room.difficulty, "multi",
                            int(time.time() - room.started_at),
                        )
                    await room.broadcast({"type": "game_over", "winner": player["name"]})
                await room.broadcast(room.state())

            elif action == "check" and room and room.started:
                result = sudoku.check_board(room.puzzle, room.solution, msg.get("board"))
                result["type"] = "check_result"
                await ws.send_text(json.dumps(result))

    except WebSocketDisconnect:
        pass
    finally:
        if room and player_id in room.players:
            del room.players[player_id]
            if room.players:
                await room.broadcast(room.state())
            else:
                rooms.pop(room.code, None)


@app.get("/")
def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
