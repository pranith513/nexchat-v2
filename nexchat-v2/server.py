from flask import Flask, render_template, request, redirect, url_for, session, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from pymongo import MongoClient, DESCENDING
from werkzeug.security import generate_password_hash, check_password_hash
from bson import ObjectId
from datetime import datetime
from functools import wraps
from dotenv import load_dotenv
import os, uuid

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "nexchat_v2_secret_2024")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

client     = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017/"))
db         = client["nexchat_v2"]
users_col  = db["users"]
msgs_col   = db["messages"]
groups_col = db["groups"]
notifs_col = db["notifications"]

# ── MongoDB Indexes ──────────────────────────────────────────────────────────
users_col.create_index("username",  unique=True)
msgs_col.create_index([("room_id", 1), ("timestamp", 1)])
msgs_col.create_index([("receiver", 1), ("seen", 1)])
notifs_col.create_index([("recipient", 1), ("created_at", -1)])

UPLOAD_FOLDER = os.path.join("static", "uploads")
ALLOWED_EXT   = {"png","jpg","jpeg","gif","webp"}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

online_users = {}

def allowed(f):
    return "." in f and f.rsplit(".",1)[1].lower() in ALLOWED_EXT

def dm_room(a, b):
    return "dm_" + "_".join(sorted([a, b]))

def fmt_time(dt):
    if not dt: return ""
    diff = (datetime.utcnow() - dt).days
    if diff == 0:  return dt.strftime("%H:%M")
    if diff == 1:  return "Yesterday"
    if diff < 7:   return dt.strftime("%a")
    return dt.strftime("%d/%m/%y")

def save_upload(f):
    if not f or not getattr(f,"filename","") or not allowed(f.filename): return None
    ext = f.filename.rsplit(".",1)[1].lower()
    name = f"{uuid.uuid4().hex}.{ext}"
    f.save(os.path.join(UPLOAD_FOLDER, name))
    return name

def login_required(fn):
    @wraps(fn)
    def wrap(*a,**kw):
        if "username" not in session: return redirect(url_for("login"))
        return fn(*a,**kw)
    return wrap

def push_notification(recipient, ntype, data):
    doc = {"recipient": recipient, "type": ntype, "data": data, "read": False, "created_at": datetime.utcnow()}
    ins = notifs_col.insert_one(doc)
    sid = online_users.get(recipient)
    if sid:
        socketio.emit("new_notification", {
            "id": str(ins.inserted_id), "type": ntype, "data": data, "read": False,
            "time": doc["created_at"].strftime("%H:%M · %b %d")
        }, to=sid)

# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    return redirect(url_for("index") if "username" in session else url_for("login"))

@app.route("/login", methods=["GET","POST"])
def login():
    err = None
    if request.method == "POST":
        u = request.form.get("username","").strip()
        p = request.form.get("password","")
        user = users_col.find_one({"username": u})
        if user and check_password_hash(user["password"], p):
            session["username"] = u
            users_col.update_one({"username": u}, {"$set": {"online": True, "last_seen": datetime.utcnow()}})
            return redirect(url_for("index"))
        err = "Invalid username or password."
    return render_template("login.html", error=err)

@app.route("/register", methods=["GET","POST"])
def register():
    err = None
    if request.method == "POST":
        u = request.form.get("username","").strip()
        p = request.form.get("password","")
        c = request.form.get("confirm_password","")
        if len(u) < 3:    err = "Username must be at least 3 characters."
        elif len(p) < 6:  err = "Password must be at least 6 characters."
        elif p != c:      err = "Passwords do not match."
        elif users_col.find_one({"username": u}): err = "Username already taken."
        else:
            av = save_upload(request.files.get("profile_picture"))
            users_col.insert_one({"username": u, "password": generate_password_hash(p),
                "avatar": av, "bio": "", "location": "", "online": True,
                "created_at": datetime.utcnow(), "last_seen": datetime.utcnow()})
            session["username"] = u
            return redirect(url_for("index"))
    return render_template("register.html", error=err)

@app.route("/logout")
def logout():
    if "username" in session:
        users_col.update_one({"username": session["username"]}, {"$set": {"online": False, "last_seen": datetime.utcnow()}})
    session.clear()
    return redirect(url_for("login"))

# ── Pages ─────────────────────────────────────────────────────────────────────

@app.route("/index")
@login_required
def index():
    me   = session["username"]
    user = users_col.find_one({"username": me})
    convos, seen = [], set()
    for msg in msgs_col.find({"type":"dm","$or":[{"sender":me},{"receiver":me}]}).sort("timestamp",DESCENDING):
        rid = msg["room_id"]
        if rid in seen: continue
        if msg.get("deleted_for_everyone") or me in msg.get("deleted_for",[]): continue
        seen.add(rid)
        other = msg["receiver"] if msg["sender"] == me else msg["sender"]
        ou    = users_col.find_one({"username": other})
        if not ou: continue
        unread  = msgs_col.count_documents({"room_id": rid, "receiver": me, "seen": {"$ne": True}})
        preview = "📷 Image" if msg.get("image") else msg.get("content","")
        convos.append({"id": rid, "username": other, "avatar": ou.get("avatar"),
            "last_message": preview[:50], "time": fmt_time(msg["timestamp"]),
            "online": ou.get("online",False), "unread": unread, "type": "dm"})
    groups = []
    for g in groups_col.find({"members": me}).sort("updated_at", DESCENDING):
        lm   = msgs_col.find_one({"room_id": str(g["_id"]), "type": "group"}, sort=[("timestamp",DESCENDING)])
        unread = msgs_col.count_documents({"room_id": str(g["_id"]), "type":"group", "seen_by": {"$nin":[me]}})
        preview = ("📷 Image" if lm.get("image") else lm.get("content","")) if lm else ""
        groups.append({"id": str(g["_id"]), "name": g["name"], "avatar": g.get("avatar"),
            "last_message": preview[:50], "time": fmt_time(g.get("updated_at")),
            "member_count": len(g.get("members",[])), "unread": unread, "type": "group"})
    unread_notifs = notifs_col.count_documents({"recipient": me, "read": False})
    return render_template("index.html", username=me, user=user, conversations=convos,
                           groups=groups, unread_notifs=unread_notifs)

@app.route("/profile", methods=["GET","POST"])
@login_required
def profile():
    me   = session["username"]
    user = users_col.find_one({"username": me})
    err, ok = None, None
    if request.method == "POST":
        upd = {"bio": request.form.get("bio","").strip(), "location": request.form.get("location","").strip()}
        av  = save_upload(request.files.get("profile_picture"))
        if av: upd["avatar"] = av
        np = request.form.get("new_password","").strip()
        if np:
            if len(np) < 6: err = "Password must be at least 6 characters."
            else: upd["password"] = generate_password_hash(np)
        if not err:
            users_col.update_one({"username": me}, {"$set": upd})
            ok = "Profile updated!"
            user = users_col.find_one({"username": me})
    return render_template("profile.html", user=user, username=me, error=err, success=ok)

# ── DM API ────────────────────────────────────────────────────────────────────

@app.route("/api/search")
@login_required
def search_users():
    q, me = request.args.get("q","").strip(), session["username"]
    if not q: return jsonify([])
    r = users_col.find({"username": {"$regex": q, "$options":"i"}, "$expr": {"$ne":["$username", me]}}).limit(10)
    return jsonify([{"username":u["username"],"avatar":u.get("avatar"),"online":u.get("online",False),"bio":u.get("bio","")} for u in r])

@app.route("/api/messages/<other>")
@login_required
def get_dm_messages(other):
    me, rid = session["username"], dm_room(session["username"], other)
    msgs = list(msgs_col.find({"room_id":rid,"type":"dm","deleted_for_everyone":{"$ne":True},"deleted_for":{"$nin":[me]}}).sort("timestamp",1))
    msgs_col.update_many({"room_id":rid,"receiver":me,"seen":{"$ne":True}},{"$set":{"seen":True}})
    return jsonify([{"id":str(m["_id"]),"sender":m["sender"],"content":m.get("content",""),
        "image":m.get("image"),"time":m["timestamp"].strftime("%H:%M"),
        "status":"seen" if m.get("seen") else ("delivered" if m.get("delivered") else "sent"),
        "deleted":m.get("deleted_for_everyone",False)} for m in msgs])

@app.route("/api/user/<uname>")
@login_required
def get_user(uname):
    u = users_col.find_one({"username": uname})
    if not u: return jsonify({"error":"Not found"}),404
    return jsonify({"username":u["username"],"avatar":u.get("avatar"),"online":u.get("online",False),
        "bio":u.get("bio",""),"location":u.get("location",""),
        "last_seen":"Online" if u.get("online") else u.get("last_seen",datetime.utcnow()).strftime("Last seen %b %d, %H:%M")})

@app.route("/api/upload_image", methods=["POST"])
@login_required
def upload_image():
    f = save_upload(request.files.get("image"))
    if not f: return jsonify({"error":"Invalid"}),400
    return jsonify({"filename": f})

@app.route("/api/delete_message/<mid>", methods=["POST"])
@login_required
def delete_message(mid):
    me   = session["username"]
    mode = request.json.get("mode","me")
    try:
        msg = msgs_col.find_one({"_id": ObjectId(mid)})
        if not msg: return jsonify({"error":"Not found"}),404
        if mode == "everyone" and msg["sender"] == me:
            msgs_col.update_one({"_id":ObjectId(mid)},{"$set":{"deleted_for_everyone":True,"content":"","image":None}})
        else:
            msgs_col.update_one({"_id":ObjectId(mid)},{"$addToSet":{"deleted_for":me}})
        return jsonify({"success":True})
    except Exception as e:
        return jsonify({"error":str(e)}),500

# ── Group API ─────────────────────────────────────────────────────────────────

@app.route("/api/groups/create", methods=["POST"])
@login_required
def create_group():
    me      = session["username"]
    name    = request.form.get("name","").strip()
    members = request.form.getlist("members[]")
    if not name:            return jsonify({"error":"Group name required"}),400
    if me not in members:   members.append(me)
    if len(members) < 2:    return jsonify({"error":"Add at least 1 member"}),400
    av  = save_upload(request.files.get("avatar"))
    now = datetime.utcnow()
    ins = groups_col.insert_one({"name":name,"avatar":av,"members":members,"admins":[me],
        "created_by":me,"created_at":now,"updated_at":now})
    gid = str(ins.inserted_id)
    for m in members:
        if m != me:
            push_notification(m, "group_invite", {"group_id":gid,"group_name":name,
                "invited_by":me,"text":f"{me} added you to \"{name}\""})
    socketio.emit("group_created", {"group_id":gid,"name":name,"members":members}, to=me)
    return jsonify({"success":True,"group_id":gid,"name":name})

@app.route("/api/groups/<gid>")
@login_required
def get_group(gid):
    me = session["username"]
    try: g = groups_col.find_one({"_id": ObjectId(gid)})
    except: return jsonify({"error":"Invalid"}),400
    if not g or me not in g.get("members",[]): return jsonify({"error":"Not found"}),404
    members_info = []
    for uname in g["members"]:
        u = users_col.find_one({"username": uname})
        if u: members_info.append({"username":uname,"avatar":u.get("avatar"),
            "online":u.get("online",False),"is_admin":uname in g.get("admins",[])})
    return jsonify({"id":gid,"name":g["name"],"avatar":g.get("avatar"),"members":members_info,
        "admins":g.get("admins",[]),"created_by":g.get("created_by"),
        "created_at":g["created_at"].strftime("%b %d, %Y")})

@app.route("/api/groups/<gid>/messages")
@login_required
def get_group_messages(gid):
    me = session["username"]
    try: g = groups_col.find_one({"_id": ObjectId(gid)})
    except: return jsonify({"error":"Invalid"}),400
    if not g or me not in g.get("members",[]): return jsonify({"error":"Forbidden"}),403
    msgs = list(msgs_col.find({"room_id":gid,"type":"group","deleted_for_everyone":{"$ne":True}}).sort("timestamp",1))
    msgs_col.update_many({"room_id":gid,"type":"group","seen_by":{"$nin":[me]}},{"$addToSet":{"seen_by":me}})
    return jsonify([{"id":str(m["_id"]),"sender":m["sender"],"content":m.get("content",""),
        "image":m.get("image"),"time":m["timestamp"].strftime("%H:%M"),
        "deleted":m.get("deleted_for_everyone",False)} for m in msgs])

@app.route("/api/groups/<gid>/add_member", methods=["POST"])
@login_required
def add_group_member(gid):
    me  = session["username"]
    new = request.json.get("username","").strip()
    try: g = groups_col.find_one({"_id": ObjectId(gid)})
    except: return jsonify({"error":"Invalid"}),400
    if not g or me not in g.get("admins",[]): return jsonify({"error":"Forbidden"}),403
    if new in g.get("members",[]): return jsonify({"error":"Already a member"}),400
    if not users_col.find_one({"username":new}): return jsonify({"error":"User not found"}),404
    groups_col.update_one({"_id":ObjectId(gid)},{"$addToSet":{"members":new}})
    push_notification(new,"group_invite",{"group_id":gid,"group_name":g["name"],
        "invited_by":me,"text":f"{me} added you to \"{g['name']}\""})
    return jsonify({"success":True})

@app.route("/api/groups/<gid>/leave", methods=["POST"])
@login_required
def leave_group_route(gid):
    me = session["username"]
    try:
        groups_col.update_one({"_id":ObjectId(gid)},{"$pull":{"members":me,"admins":me}})
    except: pass
    return jsonify({"success":True})

# ── Notifications API ─────────────────────────────────────────────────────────

@app.route("/api/notifications")
@login_required
def get_notifications():
    me = session["username"]
    notifs = list(notifs_col.find({"recipient":me}).sort("created_at",DESCENDING).limit(60))
    return jsonify([{"id":str(n["_id"]),"type":n["type"],"data":n["data"],
        "read":n["read"],"time":n["created_at"].strftime("%H:%M · %b %d")} for n in notifs])

@app.route("/api/notifications/read_all", methods=["POST"])
@login_required
def read_all_notifs():
    notifs_col.update_many({"recipient":session["username"],"read":False},{"$set":{"read":True}})
    return jsonify({"success":True})

@app.route("/api/notifications/<nid>/read", methods=["POST"])
@login_required
def read_notif(nid):
    try: notifs_col.update_one({"_id":ObjectId(nid),"recipient":session["username"]},{"$set":{"read":True}})
    except: pass
    return jsonify({"success":True})

@app.route("/api/notifications/<nid>/delete", methods=["POST"])
@login_required
def delete_notif(nid):
    try: notifs_col.delete_one({"_id":ObjectId(nid),"recipient":session["username"]})
    except: pass
    return jsonify({"success":True})

@app.route("/static/uploads/<filename>")
def uploaded_file(filename):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

# ── Socket.IO ─────────────────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    if "username" in session:
        me = session["username"]
        online_users[me] = request.sid
        join_room(me)                    # personal room — socketio.emit(..., to=username) now works
        users_col.update_one({"username":me},{"$set":{"online":True}})
        emit("user_status",{"username":me,"online":True},broadcast=True)
        for g in groups_col.find({"members":me}): join_room(str(g["_id"]))

@socketio.on("disconnect")
def on_disconnect():
    if "username" in session:
        me = session["username"]
        online_users.pop(me,None)
        users_col.update_one({"username":me},{"$set":{"online":False,"last_seen":datetime.utcnow()}})
        emit("user_status",{"username":me,"online":False},broadcast=True)

@socketio.on("join")
def on_join(data): join_room(data["room"])

@socketio.on("leave")
def on_leave(data): leave_room(data["room"])

@socketio.on("send_dm")
def handle_dm(data):
    sender, receiver = data["sender"], data["receiver"]
    content = data.get("content","").strip()
    image   = data.get("image")
    if not content and not image: return
    rid       = dm_room(sender, receiver)
    now       = datetime.utcnow()
    delivered = receiver in online_users
    ins = msgs_col.insert_one({"type":"dm","room_id":rid,"sender":sender,"receiver":receiver,
        "content":content,"image":image,"timestamp":now,
        "delivered":delivered,"seen":False,"deleted_for_everyone":False,"deleted_for":[]})
    emit("receive_message",{"id":str(ins.inserted_id),"sender":sender,"receiver":receiver,
        "content":content,"image":image,"time":now.strftime("%H:%M"),
        "status":"delivered" if delivered else "sent","room_id":rid,"chat_type":"dm"},to=rid)
    su = users_col.find_one({"username":sender})
    push_notification(receiver,"message",{"from":sender,
        "avatar":su.get("avatar") if su else None,
        "text":f"{sender}: {(content or '📷 Image')[:60]}","room_id":rid})

@socketio.on("send_group_message")
def handle_group_msg(data):
    sender  = data["sender"]
    gid     = data["group_id"]
    content = data.get("content","").strip()
    image   = data.get("image")
    if not content and not image: return
    try: g = groups_col.find_one({"_id":ObjectId(gid)})
    except: return
    if not g or sender not in g.get("members",[]): return
    now = datetime.utcnow()
    ins = msgs_col.insert_one({"type":"group","room_id":gid,"sender":sender,
        "content":content,"image":image,"timestamp":now,
        "seen_by":[sender],"deleted_for_everyone":False})
    groups_col.update_one({"_id":ObjectId(gid)},{"$set":{"updated_at":now}})
    su = users_col.find_one({"username":sender})
    payload = {"id":str(ins.inserted_id),"sender":sender,"content":content,"image":image,
        "time":now.strftime("%H:%M"),"group_id":gid,"chat_type":"group","group_name":g["name"],
        "sender_avatar":su.get("avatar") if su else None}
    emit("receive_message",payload,to=gid)
    for member in g.get("members",[]):
        if member != sender:
            push_notification(member,"group_message",{"group_id":gid,"group_name":g["name"],
                "from":sender,"text":f"{g['name']}: {sender}: {(content or '📷 Image')[:45]}"})

@socketio.on("typing")
def on_typing(data):
    rid = data.get("room_id") or dm_room(data["sender"],data.get("receiver",""))
    emit("user_typing",{"username":data["sender"],"room_id":rid},to=rid,include_self=False)

@socketio.on("stop_typing")
def on_stop(data):
    rid = data.get("room_id") or dm_room(data["sender"],data.get("receiver",""))
    emit("user_stop_typing",{"username":data["sender"],"room_id":rid},to=rid,include_self=False)

@socketio.on("message_seen")
def on_seen(data):
    rid,me = data["room_id"],data["viewer"]
    msgs_col.update_many({"room_id":rid,"receiver":me,"seen":{"$ne":True}},{"$set":{"seen":True}})
    emit("messages_seen",{"room_id":rid,"viewer":me},to=rid)

@socketio.on("call_offer")
def handle_call_offer(data):
    target = data["target"]
    sid    = online_users.get(target)
    if sid:
        emit("incoming_call", {
            "from":      data["from"],
            "offer":     data["offer"],
            "call_type": data["call_type"],
            "avatar":    data.get("avatar"),
        }, to=sid)
    else:
        emit("call_failed", {"reason": "User is offline"}, to=request.sid)

@socketio.on("call_answer")
def handle_call_answer(data):
    sid = online_users.get(data["target"])
    if sid:
        emit("call_answered", {"answer": data["answer"]}, to=sid)

@socketio.on("call_ice_candidate")
def handle_ice(data):
    sid = online_users.get(data["target"])
    if sid:
        emit("ice_candidate", {"candidate": data["candidate"]}, to=sid)

@socketio.on("call_end")
def handle_call_end(data):
    sid = online_users.get(data["target"])
    if sid:
        emit("call_ended", {"from": data["from"]}, to=sid)

@socketio.on("call_reject")
def handle_call_reject(data):
    sid = online_users.get(data["target"])
    if sid:
        emit("call_rejected", {"from": data["from"]}, to=sid)

if __name__ == "__main__":
    socketio.run(app, port=int(os.getenv("PORT",5000)), debug=True)
