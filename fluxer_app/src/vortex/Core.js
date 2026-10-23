// SPDX-License-Identifier: AGPL-3.0-only
// Conversation protocol extracted from VortexNode 3e208d315d8c1a3ca547dd929f9503325d062f67.
// OpenMLS and OPAQUE remain pinned dependencies; no cryptographic primitives are reimplemented here.
import {auth} from './vendor/auth.js';
import {Engine as ae, initMls as AI} from './vendor/mls.js';
import {mlsBytes} from './vendor/mls-bytes.js';

export function createVortexCore(hooks = {}) {
const {enc,dec,b64,un64,random,seal,open,hkdf,digest,store}=auth;
const $A=auth.api;
const aA=()=>null;
const sA=message=>hooks.notice?.(message);
const de=()=>hooks.roomsChanged?.();
const Te=()=>hooks.messagesChanged?.();
const cQ=()=>hooks.presenceChanged?.();
const Jc=()=>{};
const KB=()=>hooks.preferencesChanged?.();
const Ye=()=>hooks.leaveCall?.();
const qc=()=>hooks.mediaEpochChanged?.();
const vRemoteCallEvent=(room,event,payload)=>hooks.callEvent?.(room,event,payload);
const Kn=()=>{throw new Error('Conversation participants are required');};
const bt=()=>{throw new Error('Conversation name is required');};
const Ui=id=>{state.room=id; return state.rooms.find(room=>room.id===id);};
const vUnseenMessages=new Set();
async function send(t, A = "message", room = activeRoom()) {
  room = state.rooms.find(current => current.id === room?.id) || room;
  if (room && !canDirectMessage(room) && ["message", "call"].includes(A)) throw Error("Become friends before sending direct messages or starting a call.");
  if (state.closed) throw Error("Session closed");
  const replying = t.type === "message" && room?.id === state.room ? state.reply : null;
  if (replying && !t.reply) t.reply = replying.id;
  if (t.type === "delete") {
    const target = (state.messages.get(room?.id) || []).find(item => item.id === t.target);
    if (!target || target.sender !== state.me.id && room?.creator !== state.me.id && !(room?.moderators || []).includes(state.me.id)) throw Error("You can only delete your own messages.");
  }
  let e = room;
  if (!e) throw Error("Choose a conversation");
  return withDeviceLock(async () => {
    if (t.reply && e.id === state.room && state.reply?.id === t.reply) t.replyPreview = {
      display: userById(state.reply.sender).display,
      text: messagePreview(state.reply).slice(0, 160)
    };
    if (await flushOutbox(), await syncRoom(e), t.type === "message" && e.id === state.room && state.thread && (t.thread = state.thread), !command("has", e.id).has) throw Error("Waiting for a participant to connect this device");
    let {
        key: i,
        keyId: n
      } = await roomKeys(e),
      o = b64(random()),
      a = b64(await seal(i, enc.encode(JSON.stringify(t)), e.id + ":" + o)),
      s = command("encrypt", e.id, {
        data: b64(enc.encode(JSON.stringify(t)))
      }),
      r = await sign(JSON.stringify({
        room: e.id,
        id: o,
        archive: a,
        keyId: n,
        kind: A
      })),
      g = {
        room: e.id,
        id: o,
        device: state.device,
        kind: A,
        body: {
          archive: a,
          keyId: n,
          signature: r,
          mls: s.data
        }
      };
    state.outbox.push(g), await saveEngine();
    try {
      await action("event", g);
    } catch (c) {
      throw [403, 404, 409].includes(c.status) && (state.outbox = state.outbox.filter(I => I.id !== o), await saveEngine()), c;
    }
    state.outbox = state.outbox.filter(c => c.id !== o), await saveEngine(), await syncRoom(e, !1), Te();
    if (replying && state.room === e.id && state.reply?.id === replying.id) {
      state.reply = null;
      Jc();
    }
  });
}
function activeRoom() {
  return state.rooms.find(t => t.id === state.room);
}
let state = {
  pair: null,
  root: null,
  me: null,
  friendIds: new Set(),
  users: [],
  rooms: [],
  spaces: [],
  space: "",
  room: null,
  keys: new Map(),
  messages: new Map(),
  cursors: {},
  engine: null,
  device: null,
  poll: null,
  polling: !1,
  reply: null,
  edit: null,
  search: "",
  thread: null,
  typing: new Map(),
  receipts: new Map(),
  viewEnd: new Map(),
  historyBefore: new Map(),
  historyBusy: new Set(),
  historyDone: new Set(),
  forwardCursor: new Map(),
  call: null,
  notice: 0,
  unread: new Map(),
  urls: new Set(),
  prefs: {
    theme: "dark",
    tint: "#8bb5ff",
    audio: "auto",
    resolution: "auto",
    fps: 60,
    noise: !0,
    sensitivity: 0,
    favorites: [],
    emoji: [],
    status: "online"
  },
  syncing: new Set(),
  closed: !1
};
function canDirectMessage(room) {
  return room?.kind !== 'dm' || isFriend(room.meta.members.find(id => id !== state.me.id));
}
function isFriend(id) {
  return state.friendIds?.has(id) || false;
}
async function withDeviceLock(t) {
  if (!navigator.locks) throw Error("Update your browser to use secure multi-tab Chat");
  return navigator.locks.request("vortex-chat:" + state.device, async () => {
    if (state.closed) throw Error("Session closed");
    let A = await store("get", "engine:" + state.device);
    if (A) {
      let e = await hkdf(un64(state.root.secret), "device:" + state.device),
        i = JSON.parse(dec.decode(await open(e, un64(A), state.device)));
      state.engine.free(), state.engine = new ae(state.me.id + ":" + state.device, i.snapshot);
      for (let n of state.rooms) if ((i.cursors[n.id] || 0) > (state.cursors[n.id] || 0)) {
        let o = await store("get", "history:" + state.device + ":" + n.id);
        if (o) for (let a of (await roomKeys(n)).keys.values()) try {
          state.messages.set(n.id, JSON.parse(dec.decode(await open(a, un64(o), n.id))));
          break;
        } catch {}
      }
      state.joinedAt = i.joinedAt || {}, state.cursors = i.cursors, state.outbox = i.outbox;
    }
    return t();
  });
}
async function roomKeys(t) {
  let A = state.prefs.conversations?.[t.id];
  if (A && A.creator !== t.creator) throw Error("Conversation ownership changed unexpectedly");
  let e = state.keys.get(t.id);
  if (e && e.box === t.box) return e;
  let i = JSON.parse(dec.decode(un64(t.box)));
  if (!i.payload || !i.signature) throw Error("Conversation key signature is missing");
  let n = JSON.parse(i.payload),
    o = n.from;
  if (n.room !== t.id) throw Error("Conversation key context mismatch");
  if (A ? !A.members.includes(o) && o !== A.creator : o !== t.creator) throw Error("An unapproved account supplied conversation keys");
  await verifyIdentity(userById(o)), await verifySignature(o, i.payload, i.signature);
  let a = un64(n.data),
    s = userById(o);
  await verifyIdentity(s);
  let r = await crypto.subtle.importKey("raw", un64(s.identity.exchange), {
      name: "ECDH",
      namedCurve: "P-256"
    }, !1, []),
    g = await crypto.subtle.importKey("pkcs8", un64(state.root.exchange), {
      name: "ECDH",
      namedCurve: "P-256"
    }, !1, ["deriveBits"]),
    c = new Uint8Array(await crypto.subtle.deriveBits({
      name: "ECDH",
      public: r
    }, g, 256)),
    I = await open(await hkdf(c, "room-key:" + t.id), a, t.id),
    d = I.length === 32 ? {
      active: b64(I),
      history: []
    } : JSON.parse(dec.decode(I)),
    C = un64(d.active),
    Q = await hkdf(C, "archive:" + t.id),
    B = new Map();
  for (let m of [...d.history, d.active]) B.set((await digest(un64(m))).slice(0, 16), await hkdf(un64(m), "archive:" + t.id));
  let h = {
    secret: C,
    key: Q,
    keys: B,
    bundle: d,
    box: t.box,
    keyId: (await digest(C)).slice(0, 16)
  };
  return state.keys.set(t.id, h), h;
}
const verifiedIdentities = new Map();
async function verifyIdentity(t) {
  const encoded=JSON.stringify(t.identity);
  const cacheKey=state.pair.node+":"+t.id;
  const known=verifiedIdentities.get(cacheKey);
  if(known?.identity===encoded)return known.fingerprint;
  let A = await digest(enc.encode(encoded)),
    e = "identity:" + state.pair.node + ":" + t.id,
    i = await store("get", e);
  if (i && i.fingerprint !== A) throw Error("The identity key for " + t.username + " changed. Verify their identity before continuing.");
  if(!i)await store("set",e,{fingerprint:A,since:Date.now()});
  verifiedIdentities.set(cacheKey,{identity:encoded,fingerprint:A});
  return A;
}
let userById = t => state.users.find(A => A.id === t) || state.formerUsers?.find(A => A.id === t) || {
  id: t,
  display: "Unknown account",
  username: "Unknown account"
};
async function verifySignature(t, A, e) {
  let i = userById(t),
    n = await crypto.subtle.importKey("raw", un64(i.identity.sign), {
      name: "ECDSA",
      namedCurve: "P-256"
    }, !1, ["verify"]);
  if (!(await crypto.subtle.verify({
    name: "ECDSA",
    hash: "SHA-256"
  }, n, un64(e), enc.encode(A)))) throw Error("Message identity could not be verified");
}
function messagePreview(message) {
  const value = message?.payload || {};
  return value.deleted ? 'Message deleted' : value.text || value.emoji && ':' + value.emoji.name + ':' || value.files?.[0]?.name || (value.type === 'call' ? 'Call' : 'Message');
}
async function flushOutbox() {
  for (let t of [...state.outbox]) {
    let {
      rollback: A,
      ...e
    } = t;
    try {
      await action("event", e);
    } catch (i) {
      if (![403, 404, 409].includes(i.status)) throw i;
      i.status === 409 && A && (state.engine.free(), state.engine = new ae(state.me.id + ":" + state.device, A)), i.status !== 409 && sA("A pending message could not be delivered."), i.status === 409 && (await refreshRooms());
    }
    state.outbox = state.outbox.filter(i => i.id !== t.id), await saveEngine();
  }
}
let action = async (t, A = {}) => {
  const value = await $A(state.pair.url, t, A, state.pair.token);
  if (value.formerUsers) state.formerUsers = value.formerUsers;
  if (value.friendIds) state.friendIds = new Set(value.friendIds);
  if (Array.isArray(value.friends)) state.friendIds = new Set(value.friends.filter(friend => friend.status === 'friend').map(friend => friend.user === state.me.id ? friend.other : friend.user));
  return value;
};
let roomRefreshQueue=Promise.resolve();
function refreshRooms() {
  const operation=roomRefreshQueue.then(refreshRoomsNow,refreshRoomsNow);
  roomRefreshQueue=operation.catch(()=>{});return operation;
}
async function refreshRoomsNow() {
  let t = await action("rooms");
  let A = new Map(state.rooms.map(e => [e.id, e]));
  let rooms = [];
  for (let e of t.rooms) try {
    let {
      key: i
    } = await roomKeys(e);
    if (e.meta = JSON.parse(dec.decode(await open(i, un64(e.sealed), e.id))), !Array.isArray(e.meta.members) || !e.meta.members.includes(state.me.id) || !e.meta.members.includes(e.creator)) throw Error("Invalid conversation membership");
    state.prefs.conversations ??= {};
    let n = state.prefs.conversations[e.id];
    if ((!n || JSON.stringify(n.members) !== JSON.stringify(e.meta.members)) && (state.prefs.conversations[e.id] = {
      creator: e.creator,
      members: e.meta.members
    }, savePreferences().catch(() => {})), rooms.push(e), !state.messages.has(e.id)) {
      let o = await store("get", "history:" + state.device + ":" + e.id);
      if (o) for (let a of (await roomKeys(e)).keys.values()) try {
        state.messages.set(e.id, JSON.parse(dec.decode(await open(a, un64(o), e.id))));
        break;
      } catch {}
    }
    A.has(e.id) && (e.meta = {
      ...A.get(e.id).meta,
      ...e.meta
    });
  } catch (i) {
    sA(i.message);
  }
  state.spaces = t.spaces;
  state.rooms = [...new Map(rooms.map(room => [room.id, room])).values()];
  state.room && !state.rooms.some(e => e.id === state.room) && (state.room = null), state.call && !state.rooms.some(e => e.id === state.call.room) && (await Ye()), de();
}
let preferenceWrites = Promise.resolve();
async function savePreferences() {
  const contents = JSON.stringify(state.prefs);
  const persist = async () => {
    if (state.closed) return;
    const key = await hkdf(un64(state.root.secret), "preferences");
    const encrypted = b64(await seal(key, enc.encode(contents)));
    await store("set", "prefs:" + state.me.id, encrypted);
    await action("preferences", {body: encrypted});
  };
  const operation = preferenceWrites.then(persist);
  preferenceWrites = operation.catch(() => {});
  return operation;
}
async function saveEngine() {
  if (state.closed) return;
  let t = await hkdf(un64(state.root.secret), "device:" + state.device),
    A = state.engine.snapshot();
  await store("set", "engine:" + state.device, b64(await seal(t, enc.encode(JSON.stringify({
    snapshot: A,
    cursors: state.cursors,
    joinedAt: state.joinedAt || {},
    outbox: state.outbox || []
  })), state.device)));
}
async function syncRoom(t, A = !0) {
  if (!state.syncing.has(t.id)) {
    state.syncing.add(t.id);
    try {
      let e = state.cursors[t.id] || 0;
      if (!command("has", t.id).has && !Object.hasOwn(state.cursors, t.id)) {
        let i = await action("events", {
          room: t.id,
          recent: !0
        });
        t.epoch = i.epoch, t.info = i.info;
        for (let n of i.events) n.kind !== "mls" && (await processEvent(t, n)), e = n.seq;
        state.historyBefore.set(t.id, i.events[0]?.seq || 0), i.events.length < 100 && state.historyDone.add(t.id), e = i.cursor, state.cursors[t.id] = e;
      }
      for (let i = 0; i < 10; i++) {
        let n = await action("events", {
          room: t.id,
          after: e
        });
        for (let o of n.events) await processEvent(t, o), e = o.seq;
        if (await saveEngine(), n.events.length < 100) break;
      }
      if (A && !command("has", t.id).has) {
        let i = state.engine.snapshot();
        try {
          if (t.info) {
            let n = new ae(state.me.id + ":" + state.device, state.engine.snapshot()),
              o = JSON.parse(n.command(JSON.stringify({
                op: "external",
                room: t.id,
                info: t.info
              })));
            try {
              await verifyRoster(t, n);
            } catch (a) {
              throw n.free(), a;
            }
            state.engine.free(), state.engine = n, state.joinedAt ??= {}, state.joinedAt[t.id] = e, await publishCommit(t, "mls", o, {
              epoch: t.epoch
            }, i), t.epoch++;
          } else if (t.creator === state.me.id) {
            state.joinedAt ??= {}, state.joinedAt[t.id] = 0;
            let n = command("create", t.id);
            await saveEngine(), await action("room.init", {
              room: t.id,
              info: n.info
            });
          }
        } catch (n) {
          throw n.status === 409 && (state.engine.free(), state.engine = new ae(state.me.id + ":" + state.device, i), await saveEngine(), await refreshRooms()), n;
        }
      }
      A && command("has", t.id).has && (await pruneDeletedMembers(t), await addDevices(t)), await saveHistory(t, state.messages.get(t.id) || []);
    } finally {
      state.syncing.delete(t.id);
    }
  }
}
function command(t, A, e = {}) {
  return JSON.parse(state.engine.command(JSON.stringify({
    op: t,
    room: A,
    ...e
  })));
}
async function processEvent(t, A) {
  let e = A.body;
  if (A.kind === "mls") !command("has", t.id).has && e.target === state.device ? (await verifiedOperation(t, "join", {
    welcome: e.welcome,
    tree: e.tree
  }), state.joinedAt ??= {}, state.joinedAt[t.id] = A.seq) : command("has", t.id).has && A.device !== state.device && (await verifiedOperation(t, "process", {
    data: e.commit
  })), command("has", t.id).has && (t.epoch = command("members", t.id).epoch);else if (["message", "call", "typing", "receipt", "emoji"].includes(A.kind)) {
    let i = await roomKeys(t),
      n = e.keyId ? i.keys.get(e.keyId) : i.keys.values().next().value;
    if (!n) throw Error("Conversation keys are updating");
    await verifySignature(A.sender, JSON.stringify({
      room: t.id,
      id: A.id,
      archive: e.archive,
      keyId: e.keyId,
      kind: A.kind
    }), e.signature);
    let o = JSON.parse(dec.decode(await open(n, un64(e.archive), t.id + ":" + A.id)));
    if (command("has", t.id).has && A.device !== state.device && e.mls) try {
      let s = command("process", t.id, {
        data: e.mls
      });
      if (s.data && dec.decode(un64(s.data)) !== JSON.stringify(o)) throw Error("Message contents differ");
    } catch (s) {
      if (A.seq > (state.joinedAt?.[t.id] ?? 1 / 0)) throw s;
    }
    if (A.kind === "typing" || A.kind === "receipt") {
      (A.kind === "typing" ? state.typing : state.receipts).set(t.id + ":" + A.sender, A.at), state.cursors[t.id] = A.seq, cQ();
      return;
    }
    if (o.type === "call") vRemoteCallEvent(t, A, o);
    let a = state.messages.get(t.id) || [];
    if (!a.some(s => s.id === A.id)) {
      let s = aA("messages");
      t.id === state.room && !state.openingRoom && o.type === "message" && s && s.scrollHeight - s.scrollTop - s.clientHeight > 180 && (vUnseenMessages.add(t.id), !state.viewEnd.has(t.id) && state.viewEnd.set(t.id, a.filter(r => r.payload.type === "message").at(-1)?.seq || 0)), a.push({
        ...A,
        payload: o
      }), trimHistory(t, a), state.messages.set(t.id, a), t.id !== state.room && state.unread.set(t.id, (state.unread.get(t.id) || 0) + 1);
    }
  }
  state.cursors[t.id] = A.seq;
}
async function verifiedOperation(t, A, e) {
  const prior = command('has', t.id).has
    ? new Map(command('members', t.id).members.map(member => [member.identity, member.key]))
    : new Map();
  let i = new ae(state.me.id + ":" + state.device, state.engine.snapshot());
  try {
    let n = JSON.parse(i.command(JSON.stringify({
      op: A,
      room: t.id,
      ...e
    })));
    return await verifyRoster(t, i, prior), state.engine.free(), state.engine = i, n;
  } catch (n) {
    throw i.free(), n;
  }
}
async function verifyRoster(t, A, prior = new Map()) {
  let e = new Set(t.meta.members || []);
  if (JSON.parse(A.command(JSON.stringify({
    op: "members",
    room: t.id
  }))).members.map(a => dec.decode(un64(a.identity)).split(":")[0]).some(a => !e.has(a))) {
    let a = (await action("rooms")).rooms.find(g => g.id === t.id);
    if (!a) throw Error("Conversation is unavailable");
    let {
        key: s
      } = await roomKeys(a),
      r = JSON.parse(dec.decode(await open(s, un64(a.sealed), t.id)));
    if (!Array.isArray(r.members) || !r.members.includes(state.me.id) || !r.members.includes(t.creator)) throw Error("Invalid conversation membership");
    t.meta = r, e = new Set(r.members);
  }
  if (!e.size) throw Error("Conversation membership is unavailable");
  let n = (await action("room.members", {
      room: t.id
    })).members,
    o = JSON.parse(A.command(JSON.stringify({
      op: "members",
      room: t.id
    }))).members;
  for (let a of o) {
    // Sequential MLS removals may temporarily retain another revoked device.
    // Its exact credential was verified in the previous authenticated state.
    // New identities and changed keys still require current authorization.
    if (prior.get(a.identity) === a.key) continue;
    let s = dec.decode(un64(a.identity)),
      r = s.indexOf(":"),
      g = s.slice(0, r),
      c = s.slice(r + 1);
    if (r < 0 || !e.has(g)) throw Error("An unapproved device tried to join this conversation");
    let I = n.find(C => C.user === g)?.devices.find(C => C.id === c) || state.formerUsers?.find(user => user.id === g)?.devices?.find(device => device.id === c);
    if (!I) throw Error("A conversation device could not be verified");
    await verifyIdentity(userById(g)), await verifySignature(g, I.certificate.data, I.certificate.signature);
    let d = JSON.parse(I.certificate.data);
    if (d.user !== g || d.device !== c || d.mls !== a.key) throw Error("A conversation device could not be verified");
  }
}
function trimHistory(t, A) {
  if (A.length <= 2400) return;
  let e = state.viewEnd.get(t.id) ?? 1 / 0,
    i = A.findLastIndex(o => o.seq <= e);
  i < 0 && (i = A.length - 1);
  let n = Math.max(0, i - 1800);
  n && (A.splice(0, n), state.historyDone.delete(t.id)), state.historyBefore.set(t.id, Math.max(state.historyBefore.get(t.id) || 0, A[0]?.seq || 0)), A.length > 2400 && A.splice(2400);
}
async function publishCommit(t, A, e, i = {}, n = "") {
  let o = b64(random()),
    a = {
      room: t.id,
      id: o,
      device: state.device,
      kind: A,
      body: e,
      ...i
    };
  state.outbox.push({
    ...a,
    rollback: n
  }), await saveEngine();
  try {
    let s = await action("event", a);
    return state.outbox = state.outbox.filter(r => r.id !== o), await saveEngine(), s;
  } catch (s) {
    throw s.status === 409 && (state.outbox = state.outbox.filter(r => r.id !== o), await saveEngine()), s;
  }
}
async function pruneDeletedMembers(room) {
  const allowed = new Set((await action('room.members', {room: room.id})).members.map(member => member.user));
  const deleted = command('members', room.id).members.filter(member => !allowed.has(dec.decode(un64(member.identity)).split(':')[0])).sort((a, b) => b.index - a.index);
  for (const member of deleted) {
    const snapshot = state.engine.snapshot(),
      commit = command('remove', room.id, {
        index: member.index
      });
    try {
      await publishCommit(room, 'mls', commit, {
        epoch: room.epoch
      }, snapshot);
      room.epoch++;
    } catch (error) {
      state.engine.free();
      state.engine = new ae(state.me.id + ':' + state.device, snapshot);
      await saveEngine();
      throw error;
    }
  }
  if (deleted.length) await rotateArchive(room);
}
async function rotateArchive(t) {
  let A = (await action("room.members", {
    room: t.id
  })).members.map(r => r.user);
  // Retain the original creator identifier as a provenance pin, even when their
  // account is disabled. Only active room members receive the new key boxes.
  t.meta.members = t.meta.members.filter(r => A.includes(r) || r === t.creator);
  let e = await roomKeys(t),
    i = random(32),
    n = {
      active: b64(i),
      history: [...e.bundle.history, e.bundle.active]
    },
    o = await action("room.members", {
      room: t.id
    }),
    a = [];
  for (let r of o.members) a.push({
    user: r.user,
    box: await wrapKey(r.user, enc.encode(JSON.stringify(n)), t.id)
  });
  let s = await hkdf(i, "archive:" + t.id);
  await action("room.rekey", {
    room: t.id,
    members: a,
    sealed: b64(await seal(s, enc.encode(JSON.stringify(t.meta)), t.id))
  }), await refreshRooms();
}
async function wrapKey(t, A, e) {
  let i = userById(t);
  if (i.identity || (state.users = (await action("directory")).users, i = userById(t)), !i.identity) throw Error("This account is unavailable");
  await verifyIdentity(i);
  let n = await crypto.subtle.importKey("raw", un64(i.identity.exchange), {
      name: "ECDH",
      namedCurve: "P-256"
    }, !1, []),
    o = await crypto.subtle.importKey("pkcs8", un64(state.root.exchange), {
      name: "ECDH",
      namedCurve: "P-256"
    }, !1, ["deriveBits"]),
    a = new Uint8Array(await crypto.subtle.deriveBits({
      name: "ECDH",
      public: n
    }, o, 256)),
    s = b64(await seal(await hkdf(a, "room-key:" + e), A, e)),
    r = JSON.stringify({
      room: e,
      from: state.me.id,
      data: s
    });
  return b64(enc.encode(JSON.stringify({
    payload: r,
    signature: await sign(r)
  })));
}
async function sign(t) {
  let A = await crypto.subtle.importKey("pkcs8", un64(state.root.sign), {
    name: "ECDSA",
    namedCurve: "P-256"
  }, !1, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign({
    name: "ECDSA",
    hash: "SHA-256"
  }, A, enc.encode(t))));
}
async function addDevices(t) {
  if (!command("has", t.id).has) return;
  let A = await action("room.members", {
      room: t.id
    }),
    e = command("members", t.id).members;
  for (let i of A.members) if (t.meta.members?.includes(i.user)) for (let n of i.devices) {
    if (n.id === state.device) continue;
    let o = await verifyKeyPackage(i.user, n);
    if (e.some(r => r.key === o.mls)) continue;
    let a = state.engine.snapshot(),
      s = command("add", t.id, {
        package: n.keyPackage
      });
    try {
      await publishCommit(t, "mls", {
        ...s,
        target: n.id
      }, {
        epoch: t.epoch
      }, a), t.epoch++, e.push({
        key: o.mls
      });
    } catch (r) {
      throw r.status === 409 && (state.engine.free(), state.engine = new ae(state.me.id + ":" + state.device, a), await saveEngine()), r;
    }
  }
}
async function verifyKeyPackage(t, A) {
  await verifyIdentity(userById(t)), await verifySignature(t, A.certificate.data, A.certificate.signature);
  let e = JSON.parse(A.certificate.data),
    i = command("inspect", "_", {
      package: A.keyPackage
    });
  if (e.user !== t || e.device !== A.id || e.mls !== i.key || dec.decode(un64(i.identity)) !== t + ":" + A.id) throw Error("Device identity mismatch");
  return e;
}
async function saveHistory(t, A) {
  let {
    key: e
  } = await roomKeys(t);
  await store("set", "history:" + state.device + ":" + t.id, b64(await seal(e, enc.encode(JSON.stringify(A.slice(-1e4))), t.id)));
}
async function openEngine() {
  if (await AI({
    module_or_path: un64(mlsBytes)
  }), !navigator.locks) throw Error("Update your browser to use secure multi-tab Chat");
  await navigator.locks.request("vortex-device:" + state.pair.node + ":" + state.me.id, async () => {
    let t = await store("get", "device:" + state.pair.node + ":" + state.me.id);
    t || (t = b64(random()), await store("set", "device:" + state.pair.node + ":" + state.me.id, t)), state.device = t;
  }), await navigator.locks.request("vortex-chat:" + state.device, async () => {
    let t = await hkdf(un64(state.root.secret), "device:" + state.device),
      A = await store("get", "engine:" + state.device),
      e = {
        snapshot: "",
        cursors: {},
        outbox: []
      };
    A && (e = JSON.parse(dec.decode(await open(t, un64(A), state.device)))), state.engine = new ae(state.me.id + ":" + state.device, e.snapshot), state.joinedAt = e.joinedAt || {}, state.cursors = e.cursors, state.outbox = e.outbox, await registerDevice();
  });
}
async function registerDevice() {
  let t = Array.from({
      length: 16
    }, () => b64(state.engine.key_package())),
    A = JSON.stringify({
      user: state.me.id,
      device: state.device,
      mls: b64(state.engine.public_key())
    }),
    e = await sign(A);
  await saveEngine(), await action("device", {
    id: state.device,
    certificate: {
      data: A,
      signature: e
    },
    keyPackage: t[0],
    keyPackages: t
  });
}
async function createRoom(t, A = {}) {
  let e = A.members || (await Kn(t === "dm" ? "New conversation" : "Channel participants", [], t === "dm" ? state.users.filter(user => isFriend(user.id)) : state.space ? (await action("space.members", {
    space: state.space
  })).members.filter(member => !member.banned).map(member => userById(member.user)) : state.users));
  if (!e) return;
  if (t === "dm" && e.length === 1 && !isFriend(e[0])) throw Error("Become friends before starting a direct message.");
  let i = A.name;
  if (i || (i = t === "dm" && e.length === 1 ? userById(e[0]).display : await bt("New " + (state.space ? "channel" : "group chat"), "Name")), !i) return;
  let n = A.space ?? state.space,
    o = A.spaceName || state.rooms.find(d => d.space === n)?.meta.spaceName || "";
  !n && e.length > 1 && (t = "group");
  let a = b64(random()),
    s = random(32),
    r = await hkdf(s, "archive:" + a),
    g = {
      name: i,
      spaceName: o,
      category: A.category===true,
      announcement: A.announcement===true,
      parent: A.parent||null
    },
    c = [...new Set([state.me.id, ...e.filter(d => d !== state.me.id)])],
    I = [];
  g.members = c;
  for (let d of c) I.push({
    user: d,
    box: await wrapKey(d, s, a)
  });
  await action("room.create", {
    id: a,
    space: n,
    kind: t,
    sealed: b64(await seal(r, enc.encode(JSON.stringify(g)), a)),
    members: I
  }), state.keys.delete(a), await withDeviceLock(async () => {
    state.joinedAt ??= {}, state.joinedAt[a] = 0;
    let d = command("create", a);
    await saveEngine(), await action("room.init", {
      room: a,
      info: d.info
    }), await refreshRooms();
    let C = state.rooms.find(Q => Q.id === a);
    await addDevices(C);
  }), A.background ? state.rooms.find(room => room.id === a) : await Ui(a);
  return state.rooms.find(room => room.id === a);
}
async function removeMembers(t, A) {
  t = state.rooms.find(current => current.id === t.id) || t;
  const removed = new Set(Array.isArray(A) ? A : [A]);
  return withDeviceLock(async () => {
    await syncRoom(t, false);
    let e = command("members", t.id).members.filter(i => removed.has(dec.decode(un64(i.identity)).split(":")[0])).sort((i, n) => n.index - i.index);
    for (let i of e) {
      let n = state.engine.snapshot(),
        o = command("remove", t.id, {
          index: i.index
        });
      try {
        await publishCommit(t, "mls", o, {
          epoch: t.epoch
        }, n);
      } catch (a) {
        throw a.status === 409 && (state.engine.free(), state.engine = new ae(state.me.id + ":" + state.device, n), await saveEngine(), await refreshRooms()), a;
      }
      t.epoch++;
    }
    await rotateArchive(t), await qc();
  });
}
async function upload(t, A) {
  const current = await action('me');
  const limit = current.limits?.maxUpload ?? (current.policy.maxUpload || 100 * 1024 ** 3);
  if (t.size > limit) throw Error('This Node allows files up to ' + formatBytes(limit) + '.');
  let i = Math.max(1, Math.ceil(t.size / 1048576)),
    n = await fetch(state.pair.url + "/chat/objects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.pair.token
      },
      body: JSON.stringify({
        room: A.id,
        bytes: t.size + 28 * i
      })
    }),
    o = await n.json();
  if (!n.ok) throw Error(o.error);
  let a = random(32),
    s = await hkdf(a, "attachment:" + o.id),
    r = new Set(),
    g;
  for (let I = 0; I < i; I++) {
    if (g) throw g;
    let d = new Uint8Array(await t.slice(I * 1048576, Math.min(t.size, (I + 1) * 1048576)).arrayBuffer()),
      C = await seal(s, d, o.id + ":" + I),
      Q = (async () => {
        for (let B = 0; B < 4; B++) {
          let h = await fetch(state.pair.url + "/chat/object/" + o.id + "/" + I, {
            method: "PUT",
            headers: {
              Authorization: "Bearer " + state.pair.token
            },
            body: C
          });
          if (h.ok) return;
          if (![429, 503].includes(h.status)) throw Error((await h.json()).error);
          await new Promise(m => setTimeout(m, 500 * (B + 1)));
        }
        throw Error("Upload interrupted. Try again.");
      })().catch(B => {
        g = B;
      }).finally(() => r.delete(Q));
    r.add(Q), r.size >= 4 && (await Promise.race(r)), sA("Uploading " + t.name + " \xB7 " + Math.round((I + 1) / i * 100) + "%");
  }
  if (await Promise.all(r), g) throw g;
  let c = await fetch(state.pair.url + "/chat/object/" + o.id + "/finish", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + state.pair.token
    }
  });
  if (!c.ok) throw Error((await c.json()).error);
  return {
    id: o.id,
    name: t.name,
    size: t.size,
    type: t.type,
    parts: i,
    secret: b64(a)
  };
}
function formatBytes(t) {
  return t >= 1024 ** 3 ? (t / 1024 ** 3).toFixed(1) + " GB" : t >= 1024 ** 2 ? (t / 1024 ** 2).toFixed(1) + " MB" : Math.ceil(t / 1024) + " KB";
}

async function connect(pair, root) {
  if(state.engine) throw new Error('A cryptographic session is already open');
  state.pair={...pair, url:auth.origin(pair.url)};
  const config=await action('auth.config');
  if(config.node!==pair.node) throw new Error('The Node identity changed. Sign in again.');
  state.root=root;
  state.closed=false;
  state.me=await action('me');
  if(state.me.id!==pair.id) throw new Error('Account identity mismatch');
  state.users=state.me.users;
  for(const user of state.users) await verifyIdentity(user);
  const preferences=state.me.preferences || await store('get','prefs:'+state.me.id);
  if(preferences) state.prefs={...state.prefs,...JSON.parse(dec.decode(await open(await hkdf(un64(root.secret),'preferences'),un64(preferences))))};
  await openEngine();
  await refreshRooms();
  await withDeviceLock(flushOutbox);
  return state.me;
}
let synchronizing;
function sync(fresh=false) {
  if(synchronizing) return fresh?synchronizing.then(()=>sync()):synchronizing;
  synchronizing=(async()=>{
    const directory=await action('directory');
    for(const user of directory.users) await verifyIdentity(user);
    state.users=directory.users;
    if(directory.privacy)state.me.privacy=directory.privacy;
    if(typeof directory.totp==='boolean')state.me.totp=directory.totp;
    await action('friends');
    await refreshRooms();
    await withDeviceLock(async()=>{
      await flushOutbox();
      for(const room of state.rooms) await syncRoom(room);
    });
    await qc();
  })().finally(()=>{synchronizing=undefined;});
  return synchronizing;
}
async function loadHistory(room, before) {
  return withDeviceLock(async()=>{
    const page=await action('events',{room:room.id,before});
    // Historic archive events do not advance the live MLS ratchet or cursor.
    const cursor=state.cursors[room.id];
    const joined=state.joinedAt?.[room.id];
    const snapshot=state.engine.snapshot();
    try {
      state.joinedAt??={}; state.joinedAt[room.id]=Number.MAX_SAFE_INTEGER;
      for(const event of page.events) if(event.kind!=='mls') await processEvent(room,event);
      const messages=state.messages.get(room.id)||[];
      messages.sort((a,b)=>a.seq-b.seq);
      await saveHistory(room,messages);
      return page;
    } finally {
      state.engine.free(); state.engine=new ae(state.me.id+':'+state.device,snapshot);
      state.cursors[room.id]=cursor; state.joinedAt[room.id]=joined;
    }
  });
}
// Read the authenticated archive without advancing or rewinding the live MLS state.
async function* archiveEvents(room,signal,options={}) {
  let after=options.after||0,ceiling=null;
  const keys=await roomKeys(room);
  while(true) {
    signal?.throwIfAborted();
    if(state.closed)throw new Error('Sign in to read this conversation');
    const page=await action('events',{room:room.id,after,archive:true,...(options.catalog?{catalog:true}:{})});
    ceiling??=page.cursor;
    if(!page.events.length)return;
    for(const event of page.events) {
      if(event.seq<=after)throw new Error('Invalid archive ordering');
      after=event.seq;if(after>ceiling)return;
      const body=event.body,key=body.keyId?keys.keys.get(body.keyId):keys.keys.values().next().value;
      if(!key)throw new Error('Conversation keys are updating');
      await verifySignature(event.sender,JSON.stringify({room:room.id,id:event.id,archive:body.archive,keyId:body.keyId,kind:event.kind}),body.signature);
      const payload=JSON.parse(dec.decode(await open(key,un64(body.archive),room.id+':'+event.id)));
      yield {...event,payload};
    }
    if(after>=ceiling||page.events.length<100)return;
  }
}
async function* downloadChunks(file,signal) {
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>100*1024**3||!Number.isSafeInteger(file.parts)||file.parts!==Math.max(1,Math.ceil(file.size/1048576))) throw new Error('Invalid encrypted attachment');
  const secret=un64(file.secret);if(secret.length!==32)throw new Error('Invalid attachment key');
  const key=await hkdf(secret,'attachment:'+file.id);
  for(let index=0;index<file.parts;index++) {
    signal?.throwIfAborted();if(state.closed)throw new Error('Sign in to download this file');
    const response=await fetch(state.pair.url+'/chat/object/'+encodeURIComponent(file.id)+'/'+index,{headers:{Authorization:'Bearer '+state.pair.token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    if(!response.ok) throw new Error('The attachment is unavailable');
    const encrypted=new Uint8Array(await response.arrayBuffer());
    if(encrypted.length>1048604) throw new Error('Invalid encrypted attachment size');
    const plain=await open(key,encrypted,file.id+':'+index);
    if(plain.length!==Math.min(1048576,file.size-index*1048576))throw new Error('Attachment size mismatch');
    yield plain;
  }
}
async function download(file) {
  if(file.size>64*1024**2)throw new Error('Use streaming download for this attachment');
  const parts=[];for await(const part of downloadChunks(file))parts.push(part);
  return new Blob(parts,{type:file.type||'application/octet-stream'});
}
function invitationSignature(id, space, user, rooms, label) {
  return JSON.stringify({id,space,user,rooms:rooms.map(item=>({room:item.room,creator:item.creator,base:item.base,box:item.box,sealed:item.sealed})),label});
}
async function openInvitationBox(box, id, sender) {
  const envelope=JSON.parse(dec.decode(un64(box))),payload=JSON.parse(envelope.payload);
  if(payload.room!==id||payload.from!==sender)throw new Error('Invitation identity mismatch');
  await verifyIdentity(userById(sender));await verifySignature(sender,envelope.payload,envelope.signature);
  const remote=await crypto.subtle.importKey('raw',un64(userById(sender).identity.exchange),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const local=await crypto.subtle.importKey('pkcs8',un64(state.root.exchange),{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:remote},local,256));
  return open(await hkdf(secret,'room-key:'+id),un64(payload.data),id);
}
async function inviteSpace(space, user) {
  const channels=state.rooms.filter(room=>room.space===space);
  if(!channels.length)throw new Error('Create a channel before inviting someone');
  const id=b64(random()),rooms=[];
  for(const room of channels) {
    const keys=await roomKeys(room),meta={...room.meta,members:[...new Set([...room.meta.members,user])]};
    rooms.push({room:room.id,creator:room.creator,base:room.sealed,box:await wrapKey(user,enc.encode(JSON.stringify(keys.bundle)),room.id),sealed:b64(await seal(keys.key,enc.encode(JSON.stringify(meta)),room.id))});
  }
  const label=await wrapKey(user,enc.encode(JSON.stringify({name:channels[0].meta.spaceName||'Server'})),id),body={rooms,label};
  body.signature=await sign(invitationSignature(id,space,user,rooms,label));
  await action('space.invite',{id,space,user,body});return id;
}
async function invitations() {
  const values=(await action('space.invites')).invites;
  const result=[];
  for(const item of values) {
    if(item.recipient!==state.me.id||item.status!=='pending'||item.created<Date.now()/1000-7*86400)continue;
    await verifySignature(item.sender,invitationSignature(item.id,item.space,item.recipient,item.body.rooms,item.body.label),item.body.signature);
    const label=JSON.parse(dec.decode(await openInvitationBox(item.body.label,item.id,item.sender)));
    result.push({...item,name:label.name});
  }
  return result;
}
async function respondInvitation(id,accept) {
  const item=(await invitations()).find(item=>item.id===id);if(!item)throw new Error('Invitation unavailable');
  const pins={};
  if(accept)for(const channel of item.body.rooms) {
    const bytes=await openInvitationBox(channel.box,channel.room,item.sender);
    const bundle=bytes.length===32?{active:b64(bytes)}:JSON.parse(dec.decode(bytes));
    const key=await hkdf(un64(bundle.active),'archive:'+channel.room);
    const meta=JSON.parse(dec.decode(await open(key,un64(channel.sealed),channel.room)));
    if(!Array.isArray(meta.members)||!meta.members.includes(state.me.id)||!meta.members.includes(item.sender)||!meta.members.includes(channel.creator))throw new Error('Invalid invitation membership');
    pins[channel.room]={creator:channel.creator,members:meta.members};
  }
  await action('space.invite.respond',{id,accept});
  if(accept){state.prefs.conversations??={};Object.assign(state.prefs.conversations,pins);await savePreferences();await sync();}
}
async function updateMetadata(room,patch) {
  const allowed=['name','topic','position','spaceName','parent','nsfw','announcement'];
  const meta={...room.meta};for(const key of allowed)if(patch[key]!==undefined)meta[key]=patch[key];
  const keys=await roomKeys(room);
  await action('room.metadata',{room:room.id,sealed:b64(await seal(keys.key,enc.encode(JSON.stringify(meta)),room.id))});
  room.meta=meta;await refreshRooms();
}
async function mediaKey(room) {
  const key=un64(command('export',room.id).key);
  const material=await crypto.subtle.importKey('raw',key,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:enc.encode(room.id),info:enc.encode('Vortex media frames')},material,256));
}
function close() {
  state.closed=true;
  clearTimeout(state.prefTimer);
  state.engine?.free();state.engine=null;state.root=null;
  state.keys.clear();state.messages.clear();
}
return {state,connect,sync,close,send,createRoom,removeMembers,upload,download,downloadChunks,loadHistory,
  action,roomKeys,wrapKey,sign,verifySignature,verifyIdentity,openInvitationBox,savePreferences,archiveEvents,withDeviceLock,syncRoom,mediaKey,command,inviteSpace,invitations,respondInvitation,updateMetadata};
}
