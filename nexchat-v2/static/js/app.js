"use strict";
// ── State ────────────────────────────────────────────────────────────────────
let socket       = null;
let chatType     = null;   // 'dm' | 'group'
let chatTarget   = null;   // username (dm) or group name
let chatId       = null;   // roomId (dm) or groupId (group)
let currentChat  = null;   // alias used by call system
let currentGroupData = null;
let pendingImage = null;
let isTyping     = false;
let typingTimer  = null;
let ctxMsgId     = null;
let ctxMsgSender = null;
let gmSelected   = {};     // {username: true}
let unreadCount  = typeof INIT_UNREAD !== 'undefined' ? INIT_UNREAD : 0;
let activePanel  = 'chats';

// ── Emoji data ────────────────────────────────────────────────────────────────
const EMOJIS = {
  "😊 Smileys":["😀","😁","😂","🤣","😊","😇","🥰","😍","😘","🙂","🤗","🤩","🤔","😐","😶","🙄","😏","😒","😔","😟","😣","😫","😩","🥺","😢","😭","😤","😠","😡","🤯","😳","🥵","🥶","😱","😨","😰","😓","😴","🥱","😷","🤒","🤕","🤑","🤠","🥳"],
  "👍 Gestures":["👍","👎","👌","✌️","🤞","🤟","🤙","👋","🤝","🙏","💪","🦾","☝️","👆","👇","👈","👉","🖐","✋","🤚","👐","🙌","🫶","❤️","🧡","💛","💚","💙","💜","🖤","💔","💕","💞","💓","💗","💖","💘","💝","🔥","⚡","✨","💫","🌟","⭐"],
  "🌿 Nature":["🌸","🌺","🌻","🌹","🌷","🌼","🍀","🌿","🌱","🌲","🌳","🌈","☀️","🌙","⭐","💫","✨","⚡","🔥","💧","🌊","❄️","🌍","🦋","🐶","🐱","🐼","🦊","🐨","🐯","🦁","🐸","🐧","🐦","🦜","🐬","🐳","🦈","🐙"],
  "🍕 Food":["🍕","🍔","🍟","🌮","🌯","🍣","🍜","🍱","🍛","🍝","🥗","🍗","🥩","🍳","🧇","🥞","🍰","🎂","🍩","🍪","🍫","🍬","🍭","🍦","☕","🧋","🍵","🧃","🥤","🍺","🥂","🍾","🎉","🎊","🎁","🎮","🎯","🏆","🎵","🎶"],
};

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  initSocket();
  buildEmojiPicker();
  initSearch();
  initInput();
  initContextMenu();
  initGroupModal();
  requestNotifPermission();
  updateBadge(unreadCount);
});

// ── Socket ───────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();
  socket.on("connect", () => console.log("[NexChat] Socket connected"));

  socket.on("receive_message", data => {
    const isCurrentChat =
      (data.chat_type === "dm"    && data.room_id === chatId) ||
      (data.chat_type === "group" && data.group_id === chatId);

    if (isCurrentChat) {
      const dir = data.sender === CURRENT_USER ? "sent" : "recv";
      appendMsg(data, dir);
      if (data.sender !== CURRENT_USER && data.chat_type === "dm")
        socket.emit("message_seen", { room_id: chatId, viewer: CURRENT_USER });
      updateConvoPreview(data);
    } else {
      // Background message
      updateConvoPreview(data);
      const key = data.chat_type === "group" ? data.group_id : data.room_id;
      bumpUnread(key, data.chat_type);
    }
  });

  socket.on("new_notification", notif => {
    if (activePanel !== "notifications") {
      unreadCount++;
      updateBadge(unreadCount);
    }
    // Show toast if not in that chat
    const isInChat =
      (notif.type === "message"       && notif.data.room_id === chatId) ||
      (notif.type === "group_message" && notif.data.group_id === chatId);
    if (!isInChat) {
      showToast(notif);
      showBrowserNotif(notif.data.from || notif.data.group_name, notif.data.text);
    }
    // Prepend to panel if open
    if (activePanel === "notifications") prependNotifItem(notif);
  });

  socket.on("user_typing", data => {
    if (data.room_id === chatId) {
      g("typingName").textContent = data.username;
      g("typingBar").classList.remove("d-none");
    }
  });
  socket.on("user_stop_typing", data => {
    if (data.room_id === chatId) g("typingBar").classList.add("d-none");
  });
  socket.on("user_status", data => updateOnlineUI(data.username, data.online));
  socket.on("messages_seen", data => {
    if (data.room_id === chatId && data.viewer !== CURRENT_USER) markAllSeen();
  });

  // ── WebRTC call signaling (inside initSocket so `socket` is never null) ──────
  socket.on("incoming_call", data => {
    if (peerConn) {
      // Already in a call — auto-reject
      socket.emit("call_reject", { target: data.from, from: CURRENT_USER });
      return;
    }
    pendingOffer = data;
    showIncomingToast(data);
  });

  socket.on("call_answered", async data => {
    if (!peerConn) return;
    try {
      await peerConn.setRemoteDescription(new RTCSessionDescription(data.answer));
      setCallStatus("Connecting...", "calling");
    } catch(e) { console.error("[NexChat] call_answered:", e); }
  });

  socket.on("ice_candidate", async data => {
    if (!peerConn) return;
    try {
      await peerConn.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch(e) { console.error("[NexChat] ice_candidate:", e); }
  });

  socket.on("call_ended",   () => endCall(false));
  socket.on("call_rejected", () => {
    setCallStatus("Call declined", "calling");
    setTimeout(() => endCall(false), 1800);
  });
  socket.on("call_failed", data => {
    setCallStatus(data.reason || "Call failed", "calling");
    setTimeout(() => endCall(false), 2000);
  });
}

// ── Open Chat ─────────────────────────────────────────────────────────────────
window.openChat = async function(name, type, id) {
  if (chatId) socket.emit("leave", { room: chatId });

  chatType   = type;
  chatTarget = name;
  chatId     = id;
  currentChat = name;

  g("welcomeScreen").classList.add("d-none");
  g("chatActive").classList.remove("d-none");
  g("groupInfoBtn").classList.toggle("d-none", type !== "group");
  g("groupDrawer").classList.add("d-none");
  g("typingBar").classList.add("d-none");

  if (window.innerWidth <= 660) g("chatWin").classList.add("mob-open");

  // Mark active in list
  document.querySelectorAll(".citem").forEach(el => el.classList.toggle("active", el.dataset.id === id));
  clearUnreadBadge(id);

  await loadChatHeader(name, type, id);
  await loadMessages(type, id, name);

  socket.emit("join", { room: id });
  if (type === "dm") socket.emit("message_seen", { room_id: id, viewer: CURRENT_USER });
  g("msgInput").focus();
};

async function loadChatHeader(name, type, id) {
  const hAv     = g("hdrAv");
  const hName   = g("hdrName");
  const hStatus = g("hdrStatus");

  if (type === "group") {
    hAv.className = "hdr-av group-av";
    try {
      const res  = await fetch(`/api/groups/${id}`);
      currentGroupData = await res.json();
      if (currentGroupData.avatar)
        hAv.innerHTML = `<img src="/static/uploads/${currentGroupData.avatar}" onerror="this.style.display='none'"/>`;
      else hAv.textContent = name[0].toUpperCase();
      hName.textContent   = currentGroupData.name;
      hStatus.textContent = `${currentGroupData.members.length} members`;
      hStatus.className   = "hdr-status";
    } catch(e) { hAv.textContent = name[0].toUpperCase(); hName.textContent = name; }
  } else {
    hAv.className = "hdr-av";
    currentGroupData = null;
    try {
      const res  = await fetch(`/api/user/${name}`);
      const user = await res.json();
      if (user.avatar)
        hAv.innerHTML = `<img src="/static/uploads/${user.avatar}" onerror="this.style.display='none'"/>`;
      else hAv.textContent = name[0].toUpperCase();
      hName.textContent   = user.username;
      hStatus.textContent = user.online ? "Online" : user.last_seen;
      hStatus.className   = user.online ? "hdr-status is-on" : "hdr-status";
    } catch(e) { hAv.textContent = name[0].toUpperCase(); hName.textContent = name; }
  }
}

async function loadMessages(type, id, name) {
  const area = g("msgsArea");
  area.innerHTML = `<div style="display:flex;justify-content:center;padding:30px"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try {
    const url  = type === "group" ? `/api/groups/${id}/messages` : `/api/messages/${name}`;
    const res  = await fetch(url);
    const msgs = await res.json();
    area.innerHTML = "";
    if (!msgs.length) {
      area.innerHTML = `<div style="text-align:center;color:var(--td);margin:auto;font-size:14px;padding:20px">${type==='group'?'Group created! Start chatting 🎉':'No messages yet — say hi! 👋'}</div>`;
      return;
    }
    let lastDate = null;
    msgs.forEach(msg => {
      const d = fmtDate(msg.timestamp);
      if (d !== lastDate) { insertDateSep(area, d); lastDate = d; }
      const dir = msg.sender === CURRENT_USER ? "sent" : "recv";
      appendMsg(msg, dir, false, type === "group");
    });
    scrollBottom();
  } catch(e) { console.error(e); area.innerHTML = `<div style="text-align:center;color:var(--td);padding:20px">Failed to load messages.</div>`; }
}

function appendMsg(msg, dir, scroll = true, isGroup = false) {
  const area   = g("msgsArea");
  const isSent = dir === "sent";

  const bubbleContent = msg.deleted
    ? `<span class="bubble deleted">🚫 This message was deleted</span>`
    : msg.image
      ? `<div class="bubble"><img src="/static/uploads/${msg.image}" onclick="openImgModal('/static/uploads/${msg.image}')" alt="img"/></div>`
      : `<div class="bubble" data-id="${msg.id||''}" data-sender="${msg.sender||''}">${esc(msg.content)}</div>`;

  const statusHtml = isSent
    ? `<span class="msg-st ${msg.status||'sent'}">${{sent:'✓',delivered:'✓✓',seen:'✓✓'}[msg.status||'sent']||'✓'}</span>` : "";

  const senderName = (!isSent && isGroup)
    ? `<div class="msg-sender-name">${esc(msg.sender)}</div>` : "";

  const avatarHtml = !isSent
    ? `<div class="msg-av">${msg.sender_avatar?`<img src="/static/uploads/${msg.sender_avatar}" onerror="this.style.display='none'"/>`:''}${msg.sender?msg.sender[0].toUpperCase():''}</div>` : "";

  const row = document.createElement("div");
  row.className = `msg-row ${dir}`;
  row.dataset.id = msg.id || "";
  row.innerHTML = `
    ${avatarHtml}
    <div class="msg-body">
      ${senderName}
      ${bubbleContent}
      <div class="msg-meta">
        <span class="msg-time">${msg.time}</span>
        ${statusHtml}
      </div>
    </div>`;

  const bubble = row.querySelector(".bubble:not(.deleted)");
  if (bubble) bubble.addEventListener("contextmenu", e => showCtxMenu(e, msg.id, msg.sender));

  area.appendChild(row);
  if (scroll) scrollBottom();
}

function markAllSeen() {
  document.querySelectorAll(".msg-row.sent .msg-st").forEach(el => {
    el.className = "msg-st seen"; el.textContent = "✓✓";
  });
}

// ── Send Message ──────────────────────────────────────────────────────────────
function initInput() {
  g("sendBtn").addEventListener("click", sendMessage);
  g("msgInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  g("msgInput").addEventListener("input", handleTyping);
  g("imgBtn").addEventListener("click", () => g("imgInput").click());
  g("imgInput").addEventListener("change", handleImgSelect);
  g("emojiToggle").addEventListener("click", e => { e.stopPropagation(); g("emojiPicker").classList.toggle("d-none"); });
  document.addEventListener("click", e => {
    if (!g("emojiPicker").contains(e.target) && e.target !== g("emojiToggle")) g("emojiPicker").classList.add("d-none");
  });
}

function sendMessage() {
  if (!chatId) return;
  const content = g("msgInput").value.trim();
  if (!content && !pendingImage) return;

  const evName = chatType === "group" ? "send_group_message" : "send_dm";
  const payload = chatType === "group"
    ? { sender: CURRENT_USER, group_id: chatId, content, image: pendingImage }
    : { sender: CURRENT_USER, receiver: chatTarget, content, image: pendingImage };

  socket.emit(evName, payload);
  g("msgInput").value = "";
  pendingImage = null;
  g("imgStrip").classList.add("d-none");
  g("imgThumb").src = "";
  stopTyping();
}

function handleTyping() {
  if (!chatId) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", chatType === "group"
      ? { sender: CURRENT_USER, room_id: chatId }
      : { sender: CURRENT_USER, receiver: chatTarget, room_id: chatId });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1800);
}

function stopTyping() {
  if (!isTyping) return;
  isTyping = false;
  if (chatId)
    socket.emit("stop_typing", chatType === "group"
      ? { sender: CURRENT_USER, room_id: chatId }
      : { sender: CURRENT_USER, receiver: chatTarget, room_id: chatId });
}

// ── Image Upload ──────────────────────────────────────────────────────────────
async function handleImgSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { g("imgThumb").src = ev.target.result; g("imgStrip").classList.remove("d-none"); };
  reader.readAsDataURL(file);
  const fd = new FormData(); fd.append("image", file);
  try {
    const res  = await fetch("/api/upload_image", { method:"POST", body:fd });
    const data = await res.json();
    if (data.filename) pendingImage = data.filename;
  } catch(e) { console.error(e); }
  e.target.value = "";
}
window.removeImg = () => { pendingImage = null; g("imgThumb").src = ""; g("imgStrip").classList.add("d-none"); };

// ── Emoji ─────────────────────────────────────────────────────────────────────
function buildEmojiPicker() {
  const ep = g("emojiPicker");
  let html = "";
  for (const [cat, emojis] of Object.entries(EMOJIS)) {
    html += `<div class="em-cat">${cat}</div><div class="em-grid">`;
    emojis.forEach(em => { html += `<button class="em-btn" onclick="insertEmoji('${em}')">${em}</button>`; });
    html += `</div>`;
  }
  ep.innerHTML = html;
}
window.insertEmoji = function(em) {
  const inp = g("msgInput"), pos = inp.selectionStart, v = inp.value;
  inp.value = v.slice(0,pos)+em+v.slice(pos);
  inp.selectionStart = inp.selectionEnd = pos+em.length;
  inp.focus();
};

// ── Search ────────────────────────────────────────────────────────────────────
function initSearch() {
  let timer;
  g("searchInput").addEventListener("input", () => {
    const q = g("searchInput").value.trim();
    g("sClear").classList.toggle("d-none", !q);
    clearTimeout(timer);
    if (!q) { hideDrop("searchDropdown"); return; }
    timer = setTimeout(() => doSearch(q), 280);
  });
  document.addEventListener("click", e => {
    if (!g("searchInput").contains(e.target) && !g("searchDropdown").contains(e.target)) hideDrop("searchDropdown");
  });
}

async function doSearch(q) {
  try {
    const res   = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const dd    = g("searchDropdown");
    dd.innerHTML = "";
    dd.classList.remove("d-none");
    if (!users.length) { dd.innerHTML = `<li class="sdr-no">No users found</li>`; return; }
    users.forEach(u => {
      const li = document.createElement("li");
      li.className = "sdr-item";
      li.innerHTML = `
        <div class="ci-av" style="width:36px;height:36px">
          ${u.avatar?`<img src="/static/uploads/${u.avatar}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'"/>`:''}
          <span class="av-init" style="font-size:13px">${u.username[0].toUpperCase()}</span>
          <span class="sdot ${u.online?'on':'off'}"></span>
        </div>
        <div><div style="font-size:13px;font-weight:600">${esc(u.username)}</div>${u.bio?`<div style="font-size:11px;color:var(--tm)">${esc(u.bio)}</div>`:''}</div>
        ${u.online?`<span style="font-size:11px;color:var(--online)">●</span>`:''}`;
      li.onclick = () => {
        clearSearch();
        const rid = "dm_"+[CURRENT_USER,u.username].sort().join("_");
        openChat(u.username,"dm",rid);
        ensureDmItem(u, rid);
      };
      dd.appendChild(li);
    });
  } catch(e) { console.error(e); }
}

window.clearSearch = () => { g("searchInput").value=""; g("sClear").classList.add("d-none"); hideDrop("searchDropdown"); };
window.focusSearch = () => { setPanel("chats", document.querySelector('.ib-btn[title="Search"]')); setTimeout(()=>g("searchInput").focus(),50); };
function hideDrop(id) { const el=g(id); if(el){el.classList.add("d-none");el.innerHTML="";} }

function ensureDmItem(user, rid) {
  if (document.querySelector(`.citem[data-id="${rid}"]`)) return;
  let list = g("dmList");
  if (!list) {
    const es = document.querySelector("#panelChats .empty-state");
    if (es) es.remove();
    list = document.createElement("ul");
    list.className = "conv-list"; list.id = "dmList";
    document.querySelector("#panelChats .list-wrap").appendChild(list);
  }
  const li = document.createElement("li");
  li.className = "citem"; li.dataset.id = rid; li.dataset.type = "dm"; li.dataset.username = user.username;
  li.onclick = () => openChat(user.username,"dm",rid);
  li.innerHTML = `
    <div class="ci-av" style="position:relative">
      ${user.avatar?`<img src="/static/uploads/${user.avatar}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'"/>`:''}
      <span class="av-init">${user.username[0].toUpperCase()}</span>
      <span class="sdot ${user.online?'on':'off'}"></span>
    </div>
    <div class="ci-body">
      <div class="ci-top"><span class="ci-name">${esc(user.username)}</span><span class="ci-time">Now</span></div>
      <div class="ci-bot"><span class="ci-prev">Start chatting</span></div>
    </div>`;
  list.prepend(li);
}

// ── Panels ────────────────────────────────────────────────────────────────────
window.setPanel = function(name, btn) {
  activePanel = name;
  document.querySelectorAll(".ib-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  ["chats","groups","notifications"].forEach(p => g("panel"+capitalize(p)).classList.toggle("d-none", p!==name));
  if (name === "notifications") loadNotifications();
};

function capitalize(s) { return s.charAt(0).toUpperCase()+s.slice(1); }

// ── Notifications Panel ───────────────────────────────────────────────────────
async function loadNotifications() {
  const list = g("notifList");
  list.innerHTML = `<div class="notif-loading"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try {
    const res    = await fetch("/api/notifications");
    const notifs = await res.json();
    list.innerHTML = "";
    if (!notifs.length) {
      list.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><p>All caught up!</p><small>No notifications yet</small></div>`;
      return;
    }
    notifs.forEach(n => list.appendChild(buildNotifEl(n)));
    // Mark read on backend
    await fetch("/api/notifications/read_all", {method:"POST"});
    unreadCount = 0; updateBadge(0);
  } catch(e) { list.innerHTML = `<div class="notif-empty"><p>Failed to load</p></div>`; }
}

function buildNotifEl(n) {
  const li = document.createElement("div");
  li.className = `notif-item ${n.read?'':'unread'}`;
  li.dataset.id = n.id;

  const iconMap = { message:"fa-envelope", group_message:"fa-users", group_invite:"fa-user-plus", mention:"fa-at" };
  const classMap= { message:"msg", group_message:"grp", group_invite:"inv", mention:"msg" };
  const ico  = iconMap[n.type]  || "fa-bell";
  const cls  = classMap[n.type] || "msg";

  const joinBtn = (n.type === "group_invite" && n.data.group_id)
    ? `<button class="notif-join-btn" onclick="joinGroupFromNotif('${n.data.group_id}','${n.id}',this)">Open Group</button>` : "";

  li.innerHTML = `
    <div class="ni-icon ${cls}"><i class="fa-solid ${ico}"></i></div>
    <div class="ni-body">
      <div class="ni-text">${esc(n.data.text || "New notification")}</div>
      ${joinBtn}
      <div class="ni-time">${n.time}</div>
    </div>
    <button class="ni-del" onclick="deleteNotif('${n.id}',this)" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>`;

  // Click to open chat
  li.addEventListener("click", e => {
    if (e.target.closest(".ni-del") || e.target.closest(".notif-join-btn")) return;
    if (n.type === "message" && n.data.room_id) {
      openChat(n.data.from, "dm", n.data.room_id);
      setPanel("chats", document.querySelector('.ib-btn[title="Chats"]'));
    } else if ((n.type === "group_message" || n.type === "group_invite") && n.data.group_id) {
      openChat(n.data.group_name, "group", n.data.group_id);
      setPanel("groups", document.querySelector('.ib-btn[title="Groups"]'));
    }
    li.classList.remove("unread");
    fetch(`/api/notifications/${n.id}/read`, {method:"POST"}).catch(()=>{});
  });
  return li;
}

function prependNotifItem(notif) {
  const list = g("notifList");
  const empty = list.querySelector(".notif-empty");
  if (empty) empty.remove();
  const el = buildNotifEl(notif);
  list.prepend(el);
}

window.deleteNotif = async function(nid, btn) {
  try {
    await fetch(`/api/notifications/${nid}/delete`,{method:"POST"});
    btn.closest(".notif-item").remove();
    const list = g("notifList");
    if (!list.children.length)
      list.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><p>All caught up!</p></div>`;
  } catch(e) { console.error(e); }
};

window.markAllRead = async function() {
  await fetch("/api/notifications/read_all",{method:"POST"});
  document.querySelectorAll(".notif-item.unread").forEach(el=>el.classList.remove("unread"));
  unreadCount = 0; updateBadge(0);
};

window.joinGroupFromNotif = function(gid, nid, btn) {
  btn.textContent = "Opening…"; btn.disabled = true;
  fetch(`/api/groups/${gid}`).then(r=>r.json()).then(g2=>{
    if (g2.name) {
      openChat(g2.name,"group",gid);
      setPanel("groups",document.querySelector('.ib-btn[title="Groups"]'));
    }
    fetch(`/api/notifications/${nid}/read`,{method:"POST"});
  }).catch(()=>{ btn.textContent="Error"; });
};

function updateBadge(count) {
  const ibBadge  = g("ibNotifBadge");
  const navDot   = g("navNotifDot");
  if (ibBadge) { ibBadge.textContent=count>0?count:''; ibBadge.classList.toggle("d-none",count<=0); }
  if (navDot)  { navDot.textContent =count>0?count:''; navDot.classList.toggle("d-none",count<=0); }
}

// ── Group create modal ────────────────────────────────────────────────────────
function initGroupModal() {
  // Group member search
  let timer;
  const gmInp = g("gmSearch");
  if (!gmInp) return;
  gmInp.addEventListener("input", () => {
    clearTimeout(timer);
    const q = gmInp.value.trim();
    if (!q) { hideDrop("gmSearchResults"); return; }
    timer = setTimeout(() => doGmSearch(q), 280);
  });

  g("createGroupForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name    = g("gmName").value.trim();
    const members = Object.keys(gmSelected);
    if (!name) { alert("Group name is required."); return; }
    if (!members.length) { alert("Add at least one member."); return; }
    const fd = new FormData(g("createGroupForm"));
    members.forEach(m => fd.append("members[]", m));
    try {
      const res  = await fetch("/api/groups/create",{method:"POST",body:fd});
      const data = await res.json();
      if (data.success) { closeCreateGroup(); location.reload(); }
      else alert(data.error || "Error creating group.");
    } catch(e) { alert("Network error."); }
  });
}

async function doGmSearch(q) {
  try {
    const res   = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const dd    = g("gmSearchResults");
    dd.innerHTML = ""; dd.classList.remove("d-none");
    users.filter(u=>!gmSelected[u.username]).forEach(u => {
      const li = document.createElement("li");
      li.className = "sdr-item";
      li.innerHTML = `<div class="ci-av" style="width:30px;height:30px;position:relative"><span class="av-init" style="font-size:12px">${u.username[0].toUpperCase()}</span></div><span style="font-size:13px">${esc(u.username)}</span>`;
      li.onclick = () => { addGmSelected(u.username); g("gmSearch").value=""; hideDrop("gmSearchResults"); };
      dd.appendChild(li);
    });
    if (!users.length) dd.innerHTML=`<li class="sdr-no">No users found</li>`;
  } catch(e){}
}

function addGmSelected(username) {
  if (gmSelected[username]) return;
  gmSelected[username] = true;
  const tag = document.createElement("div");
  tag.className="gm-tag"; tag.id=`tag-${username}`;
  tag.innerHTML=`<span>${esc(username)}</span><button onclick="removeGmSelected('${username}')">×</button>`;
  g("gmSelectedWrap").appendChild(tag);
}

window.removeGmSelected = function(username) {
  delete gmSelected[username];
  const tag = g(`tag-${username}`);
  if (tag) tag.remove();
};

window.openCreateGroup = function() {
  gmSelected = {}; g("gmSelectedWrap").innerHTML=""; g("gmName").value="";
  g("gmSearch").value=""; g("gmAvPrev").innerHTML=`<i class="fa-solid fa-users"></i>`;
  g("createGroupModal").classList.remove("d-none");
};
window.closeCreateGroup = () => g("createGroupModal").classList.add("d-none");
window.prevGmAv = function(e) {
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();r.onload=ev=>{g("gmAvPrev").innerHTML=`<img src="${ev.target.result}"/>`;};r.readAsDataURL(f);
};

// ── Group Info Drawer ─────────────────────────────────────────────────────────
window.toggleGroupInfo = function() {
  const drawer = g("groupDrawer");
  if (!drawer.classList.contains("d-none")) { drawer.classList.add("d-none"); return; }
  if (!currentGroupData) return;
  const membersWrap = g("gd-members");
  membersWrap.innerHTML = "";
  currentGroupData.members.forEach(m => {
    const el = document.createElement("div");
    el.className = "gd-member";
    el.innerHTML=`<span class="sdot ${m.online?'on':'off'}"></span>${m.is_admin?'<i class="fa-solid fa-crown crown"></i>':''}<span>${esc(m.username)}</span>`;
    membersWrap.appendChild(el);
  });
  const isAdmin = currentGroupData.admins.includes(CURRENT_USER);
  g("gdAddBtn").classList.toggle("d-none", !isAdmin);
  drawer.classList.remove("d-none");
};

window.leaveGroup = async function() {
  if (!confirm(`Leave "${currentGroupData?.name}"?`)) return;
  try {
    await fetch(`/api/groups/${chatId}/leave`,{method:"POST"});
    location.reload();
  } catch(e){}
};

g("gdAddBtn").onclick = () => g("gdAddRow").classList.toggle("d-none");
window.addGroupMember = async function() {
  const username = g("gdAddInput").value.trim();
  if (!username) return;
  try {
    const res  = await fetch(`/api/groups/${chatId}/add_member`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username})});
    const data = await res.json();
    if (data.success) { g("gdAddInput").value=""; alert(`${username} added!`); }
    else alert(data.error||"Error");
  } catch(e){}
};

// ── Context Menu ──────────────────────────────────────────────────────────────
function initContextMenu() {
  g("ctxMe").onclick  = async () => { await deleteMsg("me");       g("ctxMenu").classList.add("d-none"); };
  g("ctxAll").onclick = async () => { await deleteMsg("everyone"); g("ctxMenu").classList.add("d-none"); };
  document.addEventListener("click",  () => g("ctxMenu").classList.add("d-none"));
  document.addEventListener("scroll", () => g("ctxMenu").classList.add("d-none"), true);
}

function showCtxMenu(e, msgId, sender) {
  e.preventDefault();
  ctxMsgId = msgId; ctxMsgSender = sender;
  g("ctxAll").classList.toggle("d-none", sender !== CURRENT_USER);
  g("ctxMenu").style.left = `${Math.min(e.clientX, window.innerWidth-190)}px`;
  g("ctxMenu").style.top  = `${Math.min(e.clientY, window.innerHeight-90)}px`;
  g("ctxMenu").classList.remove("d-none");
}

async function deleteMsg(mode) {
  if (!ctxMsgId) return;
  try {
    const res = await fetch(`/api/delete_message/${ctxMsgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode})});
    const data = await res.json();
    if (!data.success) return;
    if (mode==="me") {
      const row = document.querySelector(`.msg-row[data-id="${ctxMsgId}"]`);
      if (row) row.remove();
    } else {
      const bub = document.querySelector(`.bubble[data-id="${ctxMsgId}"]`);
      if (bub) { bub.textContent="🚫 This message was deleted"; bub.className="bubble deleted"; }
    }
  } catch(e){}
}

// ── Status / UI updates ────────────────────────────────────────────────────────
function updateOnlineUI(username, online) {
  document.querySelectorAll(`.citem[data-username="${username}"] .sdot`).forEach(el => {
    el.className = `sdot ${online?'on':'off'}`;
  });
  if (chatType === "dm" && chatTarget === username) {
    g("hdrStatus").textContent = online ? "Online" : "Last seen recently";
    g("hdrStatus").className   = online ? "hdr-status is-on" : "hdr-status";
  }
}

function updateConvoPreview(data) {
  const id = data.chat_type === "group" ? data.group_id : data.room_id;
  const name = data.chat_type === "group" ? data.group_name : (data.sender === CURRENT_USER ? data.receiver : data.sender);
  const item = document.querySelector(`.citem[data-id="${id}"]`);
  if (!item) return;
  const prev = item.querySelector(".ci-prev");
  const time = item.querySelector(".ci-time");
  const previewText = data.image ? "📷 Image" : (data.content||"").slice(0,45);
  if (prev) prev.textContent = previewText;
  if (time) time.textContent = new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  item.parentElement?.prepend(item);
}

function bumpUnread(id) {
  const item = document.querySelector(`.citem[data-id="${id}"]`);
  if (!item) return;
  let badge = item.querySelector(".ubadge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "ubadge"; badge.textContent = "0";
    item.querySelector(".ci-bot")?.appendChild(badge);
  }
  badge.textContent = parseInt(badge.textContent||"0")+1;
}

function clearUnreadBadge(id) {
  document.querySelector(`.citem[data-id="${id}"] .ubadge`)?.remove();
}

// ── Notifications (browser + toast) ───────────────────────────────────────────
function requestNotifPermission() {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
}

function showBrowserNotif(from, body) {
  if (!("Notification" in window) || Notification.permission !== "granted" || document.hasFocus()) return;
  const n = new Notification(`NexChat – ${from}`, {body});
  setTimeout(() => n.close(), 5000);
  n.onclick = () => { window.focus(); };
}

function showToast(notif) {
  const data = notif.data;
  g("toastName").textContent = data.from || data.group_name || "NexChat";
  g("toastMsg").textContent  = (data.text||"").slice(0,70);
  const av = g("toastAv");
  av.innerHTML = data.avatar
    ? `<img src="/static/uploads/${data.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'"/>` : "";
  av.textContent = av.querySelector("img") ? "" : (data.from||"N")[0].toUpperCase();
  const toast = g("toast");
  toast.classList.remove("d-none");
  toast.style.animation="none"; requestAnimationFrame(()=>{ toast.style.animation=""; });
  clearTimeout(toast._t); toast._t = setTimeout(()=>toast.classList.add("d-none"),5000);
  toast.onclick = () => {
    if (notif.type === "message" && data.room_id) openChat(data.from,"dm",data.room_id);
    else if (data.group_id) openChat(data.group_name,"group",data.group_id);
    toast.classList.add("d-none");
  };
}

// ── Mobile ────────────────────────────────────────────────────────────────────
window.mobileBack = () => g("chatWin").classList.remove("mob-open");

// ── Image Modal ────────────────────────────────────────────────────────────────
window.openImgModal = src => { g("imgModalImg").src=src; g("imgModal").classList.remove("d-none"); };

// ── Helpers ────────────────────────────────────────────────────────────────────
function g(id) { return document.getElementById(id); }
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function scrollBottom() { const a=g("msgsArea"); if(a) a.scrollTop=a.scrollHeight; }
function fmtDate(ts) {
  if (!ts) return "Today";
  try { const d=new Date(ts); return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}); } catch(e){ return "Today"; }
}
function insertDateSep(area, label) {
  const el = document.createElement("div");
  el.className="date-sep"; el.innerHTML=`<span>${label==="Today"||!label?"Today":label}</span>`;
  area.appendChild(el);
}
// ═══════════════════════════════════════════════════════════════════
// WEBRTC VOICE / VIDEO CALLS
// ═══════════════════════════════════════════════════════════════════

let peerConn          = null;
let localStream       = null;
let callWith          = null;          // username of the other person
let callDirection     = null;          // "outgoing" | "incoming"
let callTypeActive    = null;          // "voice" | "video"
let callTimerInterval = null;
let callSeconds       = 0;
let callConnectedOnce = false;         // prevents double-fire from connectionState + iceConnectionState
let isMuted       = false;
let isCameraOff   = false;
let pendingOffer  = null;   // stores incoming offer until user accepts

// ICE servers (using free Google STUN — works on local network)
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ]
};

// ── Start an outgoing call ───────────────────────────────────────────
window.startCall = async function(type) {
  if (!currentChat) {
    alert("Please open a conversation first before starting a call.");
    return;
  }
  if (chatType !== "dm") {
    alert("Calls are only supported in direct messages, not group chats.");
    return;
  }
  if (peerConn) { alert("You are already in a call."); return; }

  callWith       = currentChat;
  callDirection  = "outgoing";
  callTypeActive = type;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
    });
  } catch(e) {
    alert("Could not access microphone/camera. Please check permissions.");
    return;
  }

  showCallModal(callWith, type, "outgoing");

  // Attach local video
  if (type === "video") {
    g("localVideo").srcObject = localStream;
  }

  // Build peer connection
  peerConn = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  setupPeerConnectionHandlers();

  const offer = await peerConn.createOffer();
  await peerConn.setLocalDescription(offer);

  // Get caller's avatar from current user
  const callerUser = await fetch(`/api/user/${CURRENT_USER}`).then(r=>r.json()).catch(()=>({}));

  socket.emit("call_offer", {
    from:      CURRENT_USER,
    target:    callWith,
    offer:     offer,
    call_type: type,
    avatar:    callerUser.avatar || null
  });

  setCallStatus("Calling...", "calling");
};

// ── Accept incoming call ─────────────────────────────────────────────
g("btnAcceptCall")?.addEventListener("click", async () => {
  hideIncomingToast();
  if (!pendingOffer) return;

  const { from, offer, call_type, avatar } = pendingOffer;
  callWith       = from;
  callDirection  = "incoming";
  callTypeActive = call_type;
  pendingOffer   = null;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call_type === "video"
    });
  } catch(e) {
    alert("Could not access microphone/camera.");
    return;
  }

  showCallModal(from, call_type, "incoming", avatar);

  if (call_type === "video") {
    g("localVideo").srcObject = localStream;
  }

  peerConn = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConn.addTrack(track, localStream));
  setupPeerConnectionHandlers();

  await peerConn.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConn.createAnswer();
  await peerConn.setLocalDescription(answer);

  socket.emit("call_answer", {
    target: callWith,
    answer: answer
  });

  setCallStatus("Connecting...", "calling");
});

// ── Reject incoming call ─────────────────────────────────────────────
g("btnRejectCall")?.addEventListener("click", () => {
  if (pendingOffer) {
    socket.emit("call_reject", {
      target: pendingOffer.from,
      from:   CURRENT_USER
    });
    pendingOffer = null;
  }
  hideIncomingToast();
});

// ── End call button ──────────────────────────────────────────────────
g("btnEndCall")?.addEventListener("click", () => endCall(true));

// ── Mute toggle ──────────────────────────────────────────────────────
g("btnMute")?.addEventListener("click", () => {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = g("btnMute");
  btn.classList.toggle("active", isMuted);
  btn.innerHTML = isMuted
    ? '<i class="fa-solid fa-microphone-slash"></i>'
    : '<i class="fa-solid fa-microphone"></i>';
});

// ── Camera toggle ────────────────────────────────────────────────────
g("btnCamera")?.addEventListener("click", () => {
  isCameraOff = !isCameraOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  const btn = g("btnCamera");
  btn.classList.toggle("active", isCameraOff);
  btn.innerHTML = isCameraOff
    ? '<i class="fa-solid fa-video-slash"></i>'
    : '<i class="fa-solid fa-video"></i>';
});

// ── Speaker toggle ───────────────────────────────────────────────────
g("btnSpeaker")?.addEventListener("click", () => {
  const rv = g("remoteVideo");
  if (!rv) return;
  rv.muted = !rv.muted;
  const btn = g("btnSpeaker");
  btn.classList.toggle("active", rv.muted);
  btn.innerHTML = rv.muted
    ? '<i class="fa-solid fa-volume-xmark"></i>'
    : '<i class="fa-solid fa-volume-high"></i>';
});

// ── Shared peer connection handler setup ──────────────────────────────
// Called after peerConn is created in both startCall and the incoming accept handler.
function setupPeerConnectionHandlers() {
  peerConn.ontrack = e => {
    g("remoteVideo").srcObject = e.streams[0];
  };

  peerConn.onicecandidate = e => {
    if (e.candidate) {
      socket.emit("call_ice_candidate", {
        target:    callWith,
        candidate: e.candidate
      });
    }
  };

  // connectionState: W3C standard — fires in Chrome/Edge
  peerConn.onconnectionstatechange = () => {
    const s = peerConn?.connectionState;
    if (s === "connected") onCallConnected();
    if (["disconnected","failed","closed"].includes(s)) endCall(false);
  };

  // iceConnectionState: fires more reliably on localhost in Firefox and older Chrome
  peerConn.oniceconnectionstatechange = () => {
    const s = peerConn?.iceConnectionState;
    if (s === "connected" || s === "completed") onCallConnected();
    if (["disconnected","failed","closed"].includes(s)) endCall(false);
  };
}

// ── End call (cleanup) ───────────────────────────────────────────────
function endCall(notifyOther = true) {
  if (notifyOther && callWith) {
    socket.emit("call_end", { target: callWith, from: CURRENT_USER });
  }

  // Stop all tracks
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  if (peerConn) {
    peerConn.ontrack                  = null;
    peerConn.onicecandidate           = null;
    peerConn.onconnectionstatechange  = null;
    peerConn.oniceconnectionstatechange = null;
    peerConn.close();
    peerConn = null;
  }

  // Clear video elements
  const rv = g("remoteVideo"), lv = g("localVideo");
  if (rv) { rv.srcObject = null; rv.muted = false; }
  if (lv) lv.srcObject = null;

  // Stop timer
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callSeconds = 0;

  // Reset state
  callWith          = null;
  callDirection     = null;
  callTypeActive    = null;
  isMuted           = false;
  isCameraOff       = false;
  callConnectedOnce = false;
  pendingOffer      = null;

  // Reset speaker button icon
  const sb = g("btnSpeaker");
  if (sb) { sb.classList.remove("active"); sb.innerHTML = '<i class="fa-solid fa-volume-high"></i>'; }

  hideCallModal();
  hideIncomingToast();
}

// ── When peers connect ───────────────────────────────────────────────
function onCallConnected() {
  if (callConnectedOnce) return;   // guard: both connectionState and iceConnectionState can fire
  callConnectedOnce = true;

  setCallStatus("Connected", "connected");

  // Show video elements if video call
  if (callTypeActive === "video") {
    g("callVideoWrap").style.display = "flex";
    g("callAvatarWrap").style.display = "none";
  }

  // Start timer
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, "0");
    const s = String(callSeconds % 60).padStart(2, "0");
    const el = g("callTimer");
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);
}

// ── UI helpers ────────────────────────────────────────────────────────
function showCallModal(username, type, direction, avatarFile = null) {
  g("callUsername").textContent = username;
  g("callTimer").textContent    = "";
  g("callVideoWrap").style.display = "none";
  g("callAvatarWrap").style.display = "flex";

  // Show camera button for video calls
  g("btnCamera").classList.toggle("d-none", type !== "video");

  // Avatar
  const av = g("callAvatar");
  if (avatarFile) {
    av.innerHTML = `<img src="/static/uploads/${avatarFile}" onerror="this.style.display='none'"/>`;
    av.textContent = av.querySelector("img") ? "" : username[0].toUpperCase();
  } else {
    av.textContent = username[0].toUpperCase();
  }

  const statusText = direction === "outgoing" ? "Calling..." : "Incoming call...";
  setCallStatus(statusText, "calling");
  g("callOverlay").classList.remove("d-none");

  // Reset mute/camera UI
  isMuted = false; isCameraOff = false;
  g("btnMute").classList.remove("active");
  g("btnMute").innerHTML = '<i class="fa-solid fa-microphone"></i>';
  g("btnCamera").classList.remove("active");
  g("btnCamera").innerHTML = '<i class="fa-solid fa-video"></i>';
}

function hideCallModal() {
  g("callOverlay").classList.add("d-none");
  g("callTimer").textContent = "";
}

function setCallStatus(text, cls) {
  const el = g("callStatus");
  if (!el) return;
  el.textContent = text;
  el.className   = `call-status ${cls}`;
}

function showIncomingToast(data) {
  const toast = g("incomingCallToast");
  const av    = g("incAvatar");
  const type  = data.call_type === "video" ? "Video call" : "Voice call";

  g("incName").textContent = data.from;
  g("incType").innerHTML   = `<i class="fa-solid fa-${data.call_type === "video" ? "video" : "phone"}"></i> ${type}`;

  if (data.avatar) {
    av.innerHTML = `<img src="/static/uploads/${data.avatar}" onerror="this.style.display='none'"/>`;
  } else {
    av.textContent = data.from[0].toUpperCase();
  }

  toast.classList.remove("d-none");
  toast.style.animation = "none";
  requestAnimationFrame(() => { toast.style.animation = ""; });
}

function hideIncomingToast() {
  g("incomingCallToast").classList.add("d-none");
}
