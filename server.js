const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// pingTimeout/pingInterval ที่นานขึ้น เพื่อทนต่อการที่มือถือ "หรี่"/throttle JS
// ของแท็บที่ไม่ได้อยู่หน้าจอ (สลับแอป/ล็อกสกรีน) ค่า default (ping 25s / timeout 20s)
// สั้นเกินไปสำหรับเคสนี้ ทำให้ socket หลุดบ่อยกว่าที่ควรจะเป็นจริง ๆ
const io = new Server(server, {
    pingInterval: 25_000,
    pingTimeout: 60_000, // เดิม 20s — เพิ่มเผื่อแท็บถูกพักการทำงานชั่วคราว
});

// maxAge: ให้เบราว์เซอร์ cache ไฟล์ static (รูปไอคอนอาชีพ ฯลฯ) ไว้ ไม่ต้องโหลดซ้ำทุกครั้งที่เจอ
app.use(express.static("public", { maxAge: "7d" }));

const rooms = {};

// ระยะเวลาที่ยอม "รอ" ผู้เล่นที่หลุดการเชื่อมต่อก่อนเปลี่ยนเป็น offline
// (กันกรณีเน็ตสะดุดแค่แป๊บเดียว / มือถือล็อกสกรีน / สลับแอป แล้ว socket หลุดชั่วครู่)
const RECONNECT_GRACE_MS = 60_000; // 1 นาที

// เก็บ timer ของผู้เล่นที่กำลังรอถูกเตะ แยกไว้นอก room/player object เสมอ
// (ห้ามฝัง timer handle ไว้ใน room หรือ player เพราะ object พวกนั้นถูกส่งทั้งก้อนผ่าน
//  io.emit("room_update", room) ซึ่งต้อง JSON-serialize ได้ ถ้ามี timer handle ติดไปจะพัง)
const pendingRemovals = {};

// timer "ดำเนินการต่ออัตโนมัติ" หลังเกมจบ — แยกไว้นอก room object เหมือน pendingRemovals
// เดิม logic นี้ทำฝั่ง client ด้วย setInterval อย่างเดียว (นับ 5 วิแล้วกดให้)
// ปัญหา: ถ้าจอนั้นไม่ได้เปิดอยู่ (สลับแท็บ/พับจอ) เบราว์เซอร์จะ throttle/หยุด setInterval
// ทำให้ไม่กดต่อให้ และเกมค้าง รอจนกว่าจะมีคนเปิดจอนั้นเอง
// ย้าย "นาฬิกาจริง" มาไว้ที่ server แทน เพื่อให้เกมเดินต่อได้แม้ไม่มีจอไหนเปิดอยู่เลย
// (client ฝั่งหน้าจอที่เปิดอยู่ยังนับโชว์ UI เหมือนเดิม แต่ไม่ใช่ตัวตัดสินอีกต่อไป)
const gameOverTimers = {};

function clearGameOverTimer(roomId) {
    if (gameOverTimers[roomId]) {
        clearTimeout(gameOverTimers[roomId]);
        delete gameOverTimers[roomId];
    }
}

function scheduleAutoContinue(room, roomId) {
    clearGameOverTimer(roomId);
    gameOverTimers[roomId] = setTimeout(() => {
        delete gameOverTimers[roomId];
        const r = rooms[roomId];
        if (!r || !r.gameOver) return;
        r.continueReady = r.continueReady || {};
        r.players.filter((p) => !p.isHost).forEach((p) => {
            r.continueReady[p.id] = true;
        });
        io.to(roomId).emit("room_update", r);
    }, 5_000);
}

// ============================================================
// CONSTANTS
// ============================================================

// บทบาททีมหมาป่าทั้งหมด (ใช้ทั้งฝั่ง server และส่งให้ client ผ่าน roles_data)
// เพิ่มบทใหม่ที่นี่ที่เดียว — ทุกจุดที่ใช้จะได้รับค่าถูกต้องอัตโนมัติ
const WOLF_ROLES = new Set([
    "หมาป่า",
    "ลูกหมาป่า",
    "หมาป่าพิทักษ์",
    "หมาป่าดื้อรั้น",
    "หมาป่านักเวท",
]);

// เงื่อนไขจบเกมที่รองรับ — เพิ่มที่นี่ที่เดียวถ้าต้องการเพิ่มเงื่อนไขใหม่
const WIN_CONDITIONS = ["fool", "headhunter", "wolf", "murderer", "villager"];

const teamLabels = {
    wolf: "หมาป่า",
    villager: "ชาวบ้าน",
    fool: "คนบ้า",
    headhunter: "นักล่าหัว",
    murderer: "ฆาตกร",
};

// ============================================================
// ROLE DEFINITIONS
// ============================================================

const roles = {
    "หมาป่า":           { team: "wolf",     score: 2, messages: [] },
    "ลูกหมาป่า":        { team: "wolf",     score: 4, messages: ["จะลากใครคลิ๊กไว้"] },
    "หมาป่าพิทักษ์":   { team: "wolf",     score: 3, messages: ["ปกป้องหมาตัวไหนคลิ๊กเลย"] },
    "หมาป่าดื้อรั้น":  { team: "wolf",     score: 3, messages: ["คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย"] },
    "หมาป่านักเวท":    { team: "wolf",     score: 4, messages: ["ร่ายเวทย์ใส่ใครกดคลิ๊ก"] },

    "ชาวบ้าน":         { team: "villager", score: 3, messages: ["ไอไก่"] },
    "ผู้ถูกสาป":       { team: "villager", score: 3, messages: ["คุณได้กลายเป็นหมาป่าแล้ว"] },
    "หมอ":             { team: "villager", score: 3, messages: ["การป้องกันของคุณช่วยชีวิตผู้เล่น"] },
    "บอดี้การ์ด":      { team: "villager", score: 3, messages: ["เมื่อคืนคุณถูกโจมตี หากถูกอีกครั้งจะตาย"] },
    "นักกล้าม":        { team: "villager", score: 3, messages: ["คุณถูกโจมตี"] },
    "ผู้มีลาง":        { team: "villager", score: 3, messages: ["คนนี้เป็นฝ่ายดี", "คนนี้เป็นฝ่ายร้าย", "ไม่ทราบฝ่าย"] },
    "ยายแก่":          { team: "villager", score: 3, messages: ["ใบ้ใครคลิ๊กเลย"] },
    "แม่มด":           { team: "villager", score: 3, messages: ["เลือกยาป้องกันใส่ใครคลิ๊กเลย", "โยนยาพิษใส่ใครคลิ๊กเลย"] },
    "ศาลเตี้ย":        { team: "villager", score: 3, messages: [] },

    "คนบ้า":           { team: "solo",     score: 2, messages: [] },
    "นักล่าหัว":       { team: "solo",     score: 4, messages: [] },
    "ฆาตกร":           { team: "solo",     score: 4, messages: [] },
};

const roleDescription = {
    "หมาป่า": {
        icon: "/images/werewolf.jpg",
        title: "🐺 หมาป่า",
        desc: "ร่วมกันเลือกเหยื่อในกลุ่มหมาป่า และล่าในตอนกลางคืน  ลาง:ร้าย",
    },
    "ลูกหมาป่า": {
        icon: "/images/juniorwerewolf.jpg",
        title: "🐺 ลูกหมาป่า",
        desc: "คุณสามารถเลือกเป้าหมายไว้ได้ หากคุณตายคนที่คุณเลือกไว้จะตายตามไปด้วย  ลาง:ร้าย",
    },
    "หมาป่าพิทักษ์": {
        icon: "/images/guardianwolf.jpg",
        title: "🐺 หมาป่าพิทักษ์",
        desc: "คุณสามารถปกป้องหมาป่า จากการถูกโหวตประหารได้ 1 ครั้ง  ลาง:ร้าย",
    },
    "หมาป่าดื้อรั้น": {
        icon: "/images/stubbornwolf.jpg",
        title: "🐺 หมาป่าดื้อรั้น",
        desc: "คุณมี 2 ชีวิต  ลาง:ไม่ทราบ",
    },
    "หมาป่านักเวท": {
        icon: "/images/wizardwolf.jpg",
        title: "🐺 หมาป่านักเวทย์",
        desc: "ร่ายเวทได้ 1 คนต่อคืน หากอาชีพลางสังหรณ์มาส่องจะพบว่าคนนั้นอยู่ทีมหมาป่า  ลาง:ร้าย",
    },

    "ชาวบ้าน": {
        icon: "/images/village.jpg",
        title: "🏘️ ชาวบ้าน",
        desc: "ไม่มีพลังพิเศษ ใช้การโหวตเพื่อหาหมาป่า  ลาง:ดี",
    },
    "ผู้ถูกสาป": {
        icon: "/images/cursed.png",
        title: "🧟 ผู้ถูกสาป",
        desc: "คุณอยู่ทีมชาวบ้าน แต่ถ้าหากคุณถูกหมาป่ากัด คุณจะกลายเป็นหมาป่า  ลาง:ดีหรือร้าย",
    },
    "หมอ": {
        icon: "/images/doctor.jpg",
        title: "🩺 หมอ",
        desc: "คุณสามารถป้องกันคนได้ 1 คนให้รอดจากการถูกฆ่า แต่จะไม่สามารถปกป้องตัวเองได้  ลาง:ดี",
    },
    "บอดี้การ์ด": {
        icon: "/images/bodyguard.jpg",
        title: "💂 บอดี้การ์ด",
        desc: "ป้องกัน 1 คนต่อคืน และปกป้องตัวเองอัตโนมัติ หากการปกป้องคุณถูกโจมตีการโจมตีครั้งถัดไปคุณจะตาย  ลาง:ดี",
    },
    "นักกล้าม": {
        icon: "/images/muscleman.jpg",
        title: "💪 นักกล้าม",
        desc: "ป้องกัน 1 คนต่อคืน และปกป้องตัวเองอัตโนมัติ หากการปกป้องคุณถูกโจมตีจะเปิดเผยบทบาทผู้ที่โจมตีคุณและคุณจะตายหลังการประชุม  ลาง:ดี",
    },
    "ผู้มีลาง": {
        icon: "/images/auraseer.jpg",
        title: "🔮 ผู้มีลาง",
        desc: "เลือก 1 คนต่อคืนเพื่อดูว่าเป็นฝ่ายดีหรือฝ่ายร้าย  ลาง:ดี",
    },
    "ยายแก่": {
        icon: "/images/oldlady.jpg",
        title: "👵 ยายแก่",
        desc: "ทำให้คน 1 คนเป็นใบ้  ลาง:ดี",
    },
    "แม่มด": {
        icon: "/images/witch.jpg",
        title: "🧙‍♀️ แม่มด",
        desc: "คุณมียาพิษ และยาป้องกัน อย่างละขวด ยาป้องกันจะหมดก็ต่อเมื่อคุณป้องกันสำเร็จ  ลาง:ไม่ทราบ",
    },
    "ศาลเตี้ย": {
        icon: "/images/sheriff.jpg",
        title: "🔫 ศาลเตี้ย",
        desc: "คุณมีกระสุน 1 นัด และสามารถดูบทบาทคนได้ 1 คน เห็นเฉพาะคุณเท่านั้น  ลาง:ไม่ทราบ",
    },

    "นักล่าหัว": {
        icon: "/images/headhunter.jpg",
        title: "🎯 นักล่าหัว",
        desc: "หากเป้าหมายถูกโหวตประหาร คุณจะชนะ แต่ถ้าหากเป้าหมายคุณตายด้วยวิธีอื่น คุณจะชนะพร้อมกับสัมพันธมิตรฝ่ายร้าย  ลาง:ไม่ทราบ",
    },
    "คนบ้า": {
        icon: "/images/fool.jpg",
        title: "🃏 คนบ้า",
        desc: "ถูกโหวตประหารเพื่อชนะ  ลาง:ไม่ทราบ",
    },
    "ฆาตกร": {
        icon: "/images/murderer.jpg",
        title: "🗡️ ฆาตกร",
        desc: "สามารถฆ่าผู้เล่นได้ 1 คนต่อคืน หมาป่าฆ่าคุณไม่ได้  ลาง:ไม่ทราบ",
    },
};

// รวม roles + roleDescription เป็น object เดียว ส่งให้ client ใช้งาน (event: roles_data)
function buildRolesData() {
    const merged = {};
    const keys = new Set([...Object.keys(roles), ...Object.keys(roleDescription)]);
    keys.forEach((key) => {
        merged[key] = { ...(roles[key] || {}), ...(roleDescription[key] || {}) };
    });
    // ส่ง wolfRoles list ไปด้วย ให้ client ใช้ได้โดยไม่ต้อง hardcode
    merged.__wolfRoles = [...WOLF_ROLES];
    return merged;
}

function broadcastRoles() {
    io.emit("roles_data", buildRolesData());
}

// ============================================================
// ROOM HELPERS
// ============================================================

function genId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// หาห้องที่เปิดอยู่ล่าสุดสำหรับแนะนำ ROOM CODE อัตโนมัติ
function getLatestOpenRoom() {
    const ids = Object.keys(rooms);
    if (ids.length === 0) return null;
    const id = ids[ids.length - 1];
    const room = rooms[id];
    if (!room) return null;
    const hostPlayer = room.players.find((p) => p.isHost);
    return {
        roomId: id,
        hostName: hostPlayer ? hostPlayer.name : "",
        started: !!room.started,
        totalRooms: ids.length,
    };
}

function broadcastSuggestedRoom() {
    io.emit("suggested_room", getLatestOpenRoom());
}

// รายชื่อห้องที่ยังเปิดอยู่ทั้งหมด ให้หน้าโฮสต์เอาไปแสดงเป็นกริดให้เลือก
function getOpenRoomsList() {
    return Object.keys(rooms).map((id) => {
        const room = rooms[id];
        const hostPlayer = room.players.find((p) => p.isHost);
        return {
            roomId: id,
            hostName: hostPlayer ? hostPlayer.name : "",
            hostConnected: hostPlayer ? !hostPlayer.disconnected : false,
            playerCount: room.players.filter((p) => !p.isHost).length,
            started: !!room.started,
        };
    });
}

// ============================================================
// RECONNECT HELPERS
// ============================================================

// เมื่อผู้เล่นเชื่อมต่อใหม่ด้วย socket id ใหม่ ต้องอัปเดต id เดิม
// ที่ฝังอยู่ในโหวต/เป้าหมายต่างๆ ให้กลายเป็น id ใหม่ ไม่ให้ข้อมูลหาย
function remapPlayerId(room, oldId, newId) {
    if (oldId === newId) return;

    const maps = [
        room.votes,
        room.selectedTargets,
        room.wolfKillVotes,
        room.shieldTargets,
        room.continueReady,
    ];

    // murdererKillVote
    if (room.murdererKillVote) {
        if (room.murdererKillVote.voterId === oldId) room.murdererKillVote.voterId = newId;
        if (room.murdererKillVote.targetId === oldId) room.murdererKillVote.targetId = newId;
    }

    maps.forEach((map) => {
        if (!map) return;
        // อัปเดต key ก่อน (คนที่เป็นคน "เลือก")
        if (oldId in map) {
            map[newId] = map[oldId];
            delete map[oldId];
        }
        // อัปเดต value (คนที่ถูกเลือก)
        Object.keys(map).forEach((key) => {
            if (map[key] === oldId) map[key] = newId;
        });
    });

    room.players.forEach((p) => {
        if (p.huntTargetId === oldId) p.huntTargetId = newId;
    });

    if (room.host === oldId) room.host = newId;
}

// ============================================================
// DEATH / CLEANUP HELPERS
// ============================================================

// ลบ "เล็งเป้าหมาย" ที่ค้างอยู่บนผู้เล่นที่ตายแล้ว
// คืนค่า array ของ { victim, by } สำหรับคนที่ตายตามไปด้วย (cascade)
function cleanupAfterDeath(room, player) {
    const cascadeDeaths = [];
    const protectRoles = ["หมอ", "บอดี้การ์ด"];

    // ลูกหมาป่า: ถ้าลูกหมาป่าตาย คนที่ถูกลากไว้จะตายตาม
    if (player.role === "ลูกหมาป่า") {
        const draggedTargetId = room.selectedTargets?.[player.id];
        if (draggedTargetId) {
            const draggedTarget = room.players.find((p) => p.id === draggedTargetId);
            if (draggedTarget && draggedTarget.alive && draggedTarget.id !== player.id) {
                draggedTarget.alive = false;
                cascadeDeaths.push({ victim: draggedTarget, by: player });
                cascadeDeaths.push(...cleanupAfterDeath(room, draggedTarget));
            }
        }
    }

    // ลบ selectedTargets ที่เล็งคนที่ตายนี้อยู่
    if (room.selectedTargets) {
        Object.keys(room.selectedTargets).forEach((selectorId) => {
            if (room.selectedTargets[selectorId] !== player.id) return;
            const selector = room.players.find((p) => p.id === selectorId);
            if (selector && protectRoles.includes(selector.role)) {
                player.protected = false;
            }
            delete room.selectedTargets[selectorId];
        });

        // ลบ selectedTargets ที่ player ที่ตายแล้วเป็นคนเลือกไว้ด้วย
        if (player.id in room.selectedTargets) {
            if (protectRoles.includes(player.role)) {
                const prevTarget = room.players.find(
                    (p) => p.id === room.selectedTargets[player.id]
                );
                if (prevTarget) prevTarget.protected = false;
            }
            delete room.selectedTargets[player.id];
        }
    }

    // ลบ shieldTargets ที่เกี่ยวข้องกับ player ที่ตาย
    if (room.shieldTargets) {
        Object.keys(room.shieldTargets).forEach((selectorId) => {
            if (room.shieldTargets[selectorId] === player.id) {
                delete room.shieldTargets[selectorId];
            }
        });
        if (player.id in room.shieldTargets) {
            delete room.shieldTargets[player.id];
        }
    }

    return cascadeDeaths;
}

// ประกาศในแชทสำหรับคนที่ตายตามลูกหมาป่าไป
function announceCascadeDeaths(room, roomId, cascadeDeaths) {
    if (!cascadeDeaths || cascadeDeaths.length === 0) return;
    room.globalChatHistory = room.globalChatHistory || [];
    cascadeDeaths.forEach(({ victim, by }) => {
        const msg = {
            name: "เกม",
            text: `🐾 ${by.name} (ลูกหมาป่า) ตาย ลาก ${victim.name} ตายตามไปด้วย!`,
            type: "global",
            isSystem: true,
        };
        room.globalChatHistory.push(msg);
        io.to(roomId).emit("chat_message", msg);
    });
}

// ============================================================
// VOTE HELPERS
// ============================================================

// จำนวนโหวตที่ต้องใช้เพื่อประหาร = จำนวนผู้เล่นที่มีชีวิต / 2 ปัดขึ้น
function getVoteThreshold(room) {
    const aliveVoters = room.players.filter((p) => !p.isHost && p.alive).length;
    return { aliveVoters, threshold: Math.ceil(aliveVoters / 2) };
}

// ============================================================
// GAME END
// ============================================================

function teamOf(role) {
    return roles[role]?.team ?? null;
}

// นักล่าหัวที่ "เป้าหมายตายแล้ว" และตัวเองยังมีชีวิต ถือว่าผันตัวไปอยู่ฝ่ายชั่วร้าย
// (ชนะร่วมไปกับหมาป่า หรือ ฆาตกร — แล้วแต่ว่าฝ่ายไหนชนะเกมจริง ๆ)
function isHeadhunterActivated(player, room) {
    if (!player || player.role !== "นักล่าหัว" || !player.alive) return false;
    if (!player.huntTargetId) return false;
    const target = room.players.find((p) => p.id === player.huntTargetId);
    return !!target && target.alive === false;
}

function isWinner(player, resultTeam, room) {
    if (!player || player.isHost) return false;
    const t = teamOf(player.role);
    if (resultTeam === "wolf")     return t === "wolf" || isHeadhunterActivated(player, room);
    if (resultTeam === "villager") return t === "villager";
    if (resultTeam === "fool")     return player.role === "คนบ้า";
    if (resultTeam === "headhunter") return player.role === "นักล่าหัว";
    if (resultTeam === "murderer") return player.role === "ฆาตกร" || isHeadhunterActivated(player, room);
    return false;
}

function conditionEnabled(room, resultTeam) {
    if (!room.testerConditions) return true;
    return room.testerConditions[resultTeam] !== false;
}

// จบเกม: ตั้งค่าผลลัพธ์ + แจ้งทุกคน
function endGame(room, roomId, resultTeam) {
    if (!room || room.gameOver) return false;

    if (!conditionEnabled(room, resultTeam)) {
        io.to(room.host).emit(
            "host_error",
            `🧪 [โหมดผู้ทดสอบ] เข้าเงื่อนไขจบเกมแล้ว (ทีม${teamLabels[resultTeam] || resultTeam}ชนะ) แต่ปิดเงื่อนไขนี้ไว้เพื่อทดสอบอยู่`
        );
        return false;
    }

    const winners = room.players.filter((p) => isWinner(p, resultTeam, room));

    // ถ้านักล่าหัว "เป้าหมายตายแล้ว" ชนะร่วมไปกับฝ่ายชั่วร้ายที่ชนะเกมจริง (หมาป่า/ฆาตกร)
    // ให้ขึ้นชื่อนักล่าหัวต่อท้ายชื่อทีมที่ชนะด้วย
    const joinedByHeadhunter =
        (resultTeam === "wolf" || resultTeam === "murderer") &&
        winners.some((p) => p.role === "นักล่าหัว");

    const baseTitle = `ทีม${teamLabels[resultTeam] || resultTeam}ชนะ`;

    room.gameOver = true;
    room.gameResult = {
        team: resultTeam,
        label: teamLabels[resultTeam] || resultTeam,
        title: joinedByHeadhunter ? `${baseTitle} + นักล่าหัว` : baseTitle,
        // BUG FIX: เก็บทั้ง token และ id เพื่อให้ทั้ง host และ player ตรวจสอบได้
        winners: winners.map((p) => ({ id: p.id, token: p.token })),
    };
    room.continueReady = {};
    scheduleAutoContinue(room, roomId);

    const msg = {
        name: "เกม",
        text: `🏁 จบเกม — ${room.gameResult.title}`,
        type: "global",
        isSystem: true,
    };
    room.globalChatHistory = room.globalChatHistory || [];
    room.globalChatHistory.push(msg);
    io.to(roomId).emit("chat_message", msg);
    io.to(roomId).emit("room_update", room);
    return true;
}

// ตรวจเงื่อนไขจบเกมที่อิงจากจำนวนคนที่เหลือ
function checkGameEndGeneral(room, roomId) {
    if (!room || room.gameOver || !room.started) return;

    const alive = room.players.filter((p) => !p.isHost && p.alive);
    if (alive.length === 0) return;

    const wolves    = alive.filter((p) => teamOf(p.role) === "wolf");
    const villagers = alive.filter((p) => teamOf(p.role) === "villager");
    const solos     = alive.filter((p) => teamOf(p.role) === "solo");
    const murderer  = alive.find((p) => p.role === "ฆาตกร");

    // นักล่าหัวที่เป้าหมายตายแล้ว (รอลุ้นชนะร่วมกับหมาป่า/ฆาตกร ถ้าฝ่ายนั้นชนะเกมจริง)
    const activatedHeadhunters = alive.filter((p) => isHeadhunterActivated(p, room));

    // เงื่อนไข 4: เหลือฆาตกรรอด — คนอื่นที่เหลือเป็นได้แค่นักล่าหัวที่ผันตัวมาแล้ว (จะชนะร่วมกัน)
    if (murderer) {
        const others = alive.filter((p) => p.id !== murderer.id);
        const onlyActivatedHeadhuntersLeft = others.every((p) =>
            activatedHeadhunters.includes(p)
        );
        if (onlyActivatedHeadhuntersLeft) {
            endGame(room, roomId, "murderer");
            return;
        }
    }

    // เงื่อนไข 3: หมาป่าครบจำนวน
    if (wolves.length > 0) {
        const nonWolves = villagers.length + solos.length;
        if (wolves.length >= nonWolves) {
            if (!murderer || nonWolves === 0) {
                endGame(room, roomId, "wolf");
            }
            return;
        }
    }

    // เงื่อนไขเสริม: หมาป่าตายหมด + ไม่มีฆาตกรคุกคาม
    // (นักล่าหัวที่ผันตัวแล้วแต่ไม่มีฝ่ายชั่วร้ายให้ชนะร่วม ไม่มีความสามารถฆ่าเพื่อเคลียร์เกมเอง
    //  ดังนั้นไม่ทำให้ชาวบ้านพลาดการชนะ — ชาวบ้านชนะตามปกติ ส่วนนักล่าหัวแพ้ไปด้วย)
    if (wolves.length === 0 && !murderer) {
        endGame(room, roomId, "villager");
    }
}

// ============================================================
// SOCKET EVENTS
// ============================================================

io.on("connection", (socket) => {

    // ส่งข้อมูล roles และห้องแนะนำทันทีที่ client เชื่อมต่อ
    socket.emit("roles_data", buildRolesData());
    socket.emit("suggested_room", getLatestOpenRoom());

    // ----------------------------------------------------------------
    // CREATE ROOM
    // ----------------------------------------------------------------
    socket.on("create_room", ({ name }, cb) => {
        const id = genId();
        const hostToken = genId() + genId();

        rooms[id] = {
            id,
            host: socket.id,
            config: {},
            started: false,
            selectedTargets: {},
            shieldTargets: {},
            wolfChatHistory: [],
            globalChatHistory: [],
            nightCount: 0,
            dayCount: 0,
            isNight: false,
            voteMode: false,
            wolfKillMode: false,
            votes: {},
            wolfKillVotes: {},
            testerConditions: Object.fromEntries(WIN_CONDITIONS.map((k) => [k, true])),
            gameOver: false,
            gameResult: null,
            continueReady: {},
            players: [{
                id: socket.id,
                token: hostToken,
                name,
                isHost: true,
                role: null,
                displayRole: null,
                alive: true,
                protected: false,
                killed: false,
            }],
        };

        socket.join(id);
        io.to(id).emit("room_update", rooms[id]);
        broadcastSuggestedRoom();
        cb({ roomId: id, token: hostToken });
    });

    // ----------------------------------------------------------------
    // LIST OPEN ROOMS
    // ----------------------------------------------------------------
    socket.on("list_open_rooms", (cb) => {
        cb(getOpenRoomsList());
    });

    // ----------------------------------------------------------------
    // HOST LOGIN — เข้าคุมห้องที่เลือกจากกริด (ไม่ต้องมี token เดิมตรงกัน)
    // ----------------------------------------------------------------
    socket.on("host_login", ({ roomId, token }, cb) => {
        const room = rooms[roomId];
        if (!room) return cb({ error: "room not found" });

        const hostPlayer = room.players.find((p) => p.isHost);
        if (!hostPlayer) return cb({ error: "host slot missing" });

        const oldId = hostPlayer.id;
        remapPlayerId(room, oldId, socket.id);
        hostPlayer.id = socket.id;
        if (token) hostPlayer.token = token;
        hostPlayer.disconnected = false;
        room.host = socket.id;

        // เคลียร์ timer รอลบทั้งของ token เดิมและ token ใหม่
        [oldId, hostPlayer.token].forEach((t) => {
            if (pendingRemovals[t]) {
                clearTimeout(pendingRemovals[t].timer);
                delete pendingRemovals[t];
            }
        });

        socket.join(roomId);
        io.to(roomId).emit("room_update", room);
        broadcastSuggestedRoom();

        if (room.wolfChatHistory?.length)   socket.emit("wolf_chat_history",   room.wolfChatHistory);
        if (room.globalChatHistory?.length) socket.emit("global_chat_history", room.globalChatHistory);

        cb({ ok: true, roomData: room, token: hostPlayer.token });
    });

    // ----------------------------------------------------------------
    // JOIN ROOM
    // ----------------------------------------------------------------
    socket.on("join_room", ({ roomId, name, token }, cb) => {
        roomId = roomId.toUpperCase();
        const room = rooms[roomId];
        if (!room) return cb({ error: "room not found" });

        // ตรวจว่าเป็นการ reconnect (token ตรงกับผู้เล่นในห้อง)
        let player = token ? room.players.find((p) => p.token === token) : null;
        const isReconnect = !!player;

        if (player) {
            const oldId = player.id;
            remapPlayerId(room, oldId, socket.id);
            player.id = socket.id;
            if (name) player.name = name;
            player.disconnected = false;
            player.offline = false;

            if (pendingRemovals[token]) {
                clearTimeout(pendingRemovals[token].timer);
                delete pendingRemovals[token];
            }
        } else {
            player = room.players.find((p) => p.id === socket.id);
            if (!player) {
                player = {
                    id: socket.id,
                    token: token || genId(),
                    name,
                    isHost: false,
                    role: null,
                    displayRole: null,
                    alive: true,
                    protected: false,
                    killed: false,
                };
                room.players.push(player);
            }
        }

        socket.join(roomId);
        io.to(roomId).emit("room_update", room);

        // กลับมา reconnect ระหว่างเกม → ส่งบทเดิมกลับไปทันที (silent: กันอนิเมชันซ้ำ)
        if (isReconnect && room.started && player.role) {
            socket.emit("your_role", {
                role: player.role,
                displayRole: player.displayRole,
                huntTarget: player.huntTarget,
                huntTargetId: player.huntTargetId || null,
                roleInfo: roleDescription[player.role] || null,
                guardianShieldAvailable: player.guardianShieldAvailable || 0,
                silent: true,
            });

            if (WOLF_ROLES.has(player.role) && room.wolfChatHistory?.length) {
                socket.emit("wolf_chat_history", room.wolfChatHistory);
            }
        }

        cb({ ok: true, roomData: room, token: player.token });
    });

    // ----------------------------------------------------------------
    // UPDATE CONFIG
    // ----------------------------------------------------------------
    socket.on("update_config", ({ roomId, config }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.config = config;
        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // START GAME
    // ----------------------------------------------------------------
    socket.on("start_game", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;

        const realPlayers = room.players.filter((p) => !p.isHost);

        // ถ้าเกมจบไปแล้ว ต้องรอให้ผู้เล่นทุกคนกด "ดำเนินการต่อ" ครบก่อน
        if (room.gameOver) {
            const ready = room.continueReady || {};
            if (!realPlayers.every((p) => ready[p.id])) {
                io.to(room.host).emit(
                    "host_error",
                    "ต้องรอให้ผู้เล่นกด \"ดำเนินการต่อ\" ให้ครบทุกคนก่อน ถึงจะเริ่มเกมใหม่ได้"
                );
                return;
            }
        }

        // ล้างสถานะรอบเก่าทั้งหมด
        clearGameOverTimer(roomId);
        realPlayers.forEach((p) => {
            p.role = null;
            p.displayRole = null;
            p.alive = true;
            p.protected = false;
            p.killed = false;
            p.silenced = false;
            p.huntTarget = null;
            p.huntTargetId = null;
            p.guardianShieldAvailable = 0;
        });
        Object.assign(room, {
            votes: {},
            selectedTargets: {},
            shieldTargets: {},
            wolfKillVotes: {},
            murdererKillVote: null,
            wolfChatHistory: [],
            globalChatHistory: [],
            nightCount: 0,
            dayCount: 0,
            isNight: false,
            voteMode: false,
            wolfKillMode: false,
            murdererKillVote: null, // { voterId, targetId }
            gameOver: false,
            gameResult: null,
            continueReady: {},
        });

        // กลุ่มสุ่ม (random groups)
        const randomGroups = {
            "สุ่มชาวบ้าน":          ["ชาวบ้าน", "หมอ", "บอดี้การ์ด"],
            "สุ่มชาวบ้านสนับสนุน": ["ศาลเตี้ย", "แม่มด"],
            "สุ่มหมาป่า":           ["หมาป่า", "ลูกหมาป่า", "หมาป่าดื้อรั้น"],
            "สุ่มหมาป่าสนับสนุน":  ["หมาป่าพิทักษ์", "หมาป่านักเวท"],
            "สุ่มบทบาทการโหวต":    ["คนบ้า", "นักล่าหัว"],
        };

        // สร้างใบ role cards
        const roleCards = [];
        Object.keys(room.config).forEach((roleName) => {
            const count = room.config[roleName];
            for (let i = 0; i < count; i++) {
                if (randomGroups[roleName]) {
                    const pool = randomGroups[roleName];
                    const realRole = pool[Math.floor(Math.random() * pool.length)];
                    roleCards.push({ role: realRole, displayRole: `${roleName}/${realRole}` });
                } else {
                    roleCards.push({ role: roleName, displayRole: roleName });
                }
            }
        });

        if (roleCards.length !== realPlayers.length) {
            io.to(room.host).emit(
                "host_error",
                `จำนวน role (${roleCards.length}) ไม่เท่ากับจำนวนผู้เล่น (${realPlayers.length})`
            );
            return;
        }

        shuffle(roleCards);

        // แจกบท
        realPlayers.forEach((p, i) => {
            const card = roleCards[i];
            p.role = card.role;
            p.displayRole = card.displayRole;
            p.huntTarget = null;
            p.huntTargetId = null;
            p.guardianShieldAvailable = card.role === "หมาป่าพิทักษ์" ? 1 : 0;
        });

        // นักล่าหัว: สุ่มเป้าหมาย (ไม่ใช่ wolf/solo/ศาลเตี้ย)
        const cannotBeHuntedTeams = new Set(["wolf", "solo"]);
        const cannotBeHuntedRoles = new Set(["ศาลเตี้ย"]);

        realPlayers.forEach((p) => {
            if (p.role !== "นักล่าหัว") return;
            const targets = realPlayers.filter((x) => {
                if (x.id === p.id) return false;
                const rd = roles[x.role] || {};
                return !cannotBeHuntedTeams.has(rd.team) && !cannotBeHuntedRoles.has(x.role);
            });
            if (targets.length === 0) return;
            const t = targets[Math.floor(Math.random() * targets.length)];
            p.huntTargetId = t.id;
            p.huntTarget = t.name;
        });

        // ส่งบทให้ผู้เล่น
        realPlayers.forEach((p) => {
            io.to(p.id).emit("your_role", {
                role: p.role,
                displayRole: p.displayRole,
                huntTarget: p.huntTarget,
                huntTargetId: p.huntTargetId || null,
                roleInfo: roleDescription[p.role] || null,
                guardianShieldAvailable: p.guardianShieldAvailable || 0,
            });
        });

        room.started = true;
        room.justStarted = true;
        io.to(roomId).emit("room_update", room);
        room.justStarted = false; // ล้างทันทีหลังส่ง ไม่ให้ update ถัดไปล้างแชทซ้ำ
    });

    // ----------------------------------------------------------------
    // TOGGLE STATE (alive/protected/killed/silenced)
    // ----------------------------------------------------------------
    socket.on("toggle_state", ({ roomId, playerId, key, value }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;

        player[key] = value;

        if (key === "alive" && value === false) {
            const cascadeDeaths = cleanupAfterDeath(room, player);
            announceCascadeDeaths(room, roomId, cascadeDeaths);
            checkGameEndGeneral(room, roomId);
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // TOGGLE VOTE MODE
    // ----------------------------------------------------------------
    socket.on("toggle_vote_mode", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;

        // เปิดโหมดโหวตได้เฉพาะตอนกลางวัน (แต่ปิดโหมดที่เปิดค้างได้เสมอ)
        if (!room.voteMode && room.isNight) return;

        room.voteMode = !room.voteMode;

        if (room.voteMode) {
            room.shieldTargets = {}; // เคลียร์การวางโล่ของรอบก่อน
        } else {
            // ปิดโหมด: นับคะแนนโหวต
            const { threshold } = getVoteThreshold(room);
            const tally = {};
            Object.values(room.votes || {}).forEach((tid) => {
                tally[tid] = (tally[tid] || 0) + 1;
            });

            let executed = null;
            let shieldedPlayer = null;
            let cascadeDeaths = [];

            if (threshold > 0 && Object.keys(tally).length > 0) {
                const maxVotes = Math.max(...Object.values(tally));

                if (maxVotes >= threshold) {
                    const topCandidates = Object.keys(tally).filter(
                        (tid) => tally[tid] === maxVotes
                    );

                    // ถ้าเสมอกัน → ไม่ประหารใคร
                    if (topCandidates.length === 1) {
                        const target = room.players.find((p) => p.id === topCandidates[0]);
                        if (target && target.alive) {
                            // ตรวจหมาป่าพิทักษ์วางโล่ไว้
                            const shieldTargets = room.shieldTargets || {};
                            const guardianId = Object.keys(shieldTargets).find(
                                (gid) => shieldTargets[gid] === target.id
                            );
                            const guardian = guardianId
                                ? room.players.find((p) => p.id === guardianId)
                                : null;

                            if (guardian && guardian.alive && guardian.guardianShieldAvailable > 0) {
                                guardian.guardianShieldAvailable = 0;
                                shieldedPlayer = target;
                            } else {
                                target.alive = false;
                                executed = target;
                            }
                        }
                    }
                }
            }

            const resultMsg = {
                name: "เกม",
                text: shieldedPlayer
                    ? `ผู้เล่น...${shieldedPlayer.name} ถูกปกป้องจากการประหาร และหมาป่าพิทักษ์เสียโล่`
                    : executed
                    ? `ชาวบ้านตัดสินใจประหาร ${executed.name}`
                    : "ชาวบ้านตัดสินใจไม่ประหารใคร",
                type: "global",
                isSystem: true,
            };
            room.globalChatHistory = room.globalChatHistory || [];
            room.globalChatHistory.push(resultMsg);
            io.to(roomId).emit("chat_message", resultMsg);

            let endedByVote = false;
            if (executed) {
                cascadeDeaths = cleanupAfterDeath(room, executed);
                announceCascadeDeaths(room, roomId, cascadeDeaths);

                if (executed.role === "คนบ้า") {
                    endedByVote = endGame(room, roomId, "fool");
                } else {
                    const headhunter = room.players.find(
                        (p) => p.role === "นักล่าหัว" && p.alive && p.huntTargetId === executed.id
                    );
                    if (headhunter) endedByVote = endGame(room, roomId, "headhunter");
                }
            }

            room.votes = {};
            room.shieldTargets = {};

            if (!endedByVote) checkGameEndGeneral(room, roomId);
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // CAST VOTE
    // ----------------------------------------------------------------
    socket.on("cast_vote", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.voteMode) return;

        const voter = room.players.find((p) => p.id === socket.id);
        if (!voter || !voter.alive || voter.isHost) return;

        room.votes = room.votes || {};

        if (!targetId) {
            delete room.votes[socket.id];
        } else {
            if (targetId === socket.id) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || !target.alive) return;
            room.votes[socket.id] = targetId;
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // TOGGLE WOLF KILL MODE
    // ----------------------------------------------------------------
    socket.on("toggle_wolf_kill_mode", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;

        // เปิดโหมดเลือกฆ่าได้เฉพาะตอนกลางคืน (แต่ปิดโหมดที่เปิดค้างได้เสมอ)
        if (!room.wolfKillMode && !room.isNight) return;

        room.wolfKillMode = !room.wolfKillMode;
        room.wolfKillVotes = {};    // เคลียร์ทุกครั้งทั้งตอนเปิดและปิด
        room.murdererKillVote = null;

        if (!room.wolfKillMode) {
            // ปิดโหมด: สรุปผล → ติ๊ก killed
            // หาเป้าหมายที่หมาป่าโหวต (ไม่รวมทีมหมาป่า และไม่รวมฆาตกร)
            const wolfChosenTargets = [...new Set(
                Object.values(room.wolfKillVotes || {}).filter((tid) => {
                    const t = room.players.find((p) => p.id === tid);
                    return t && !WOLF_ROLES.has(t.role) && t.role !== "ฆาตกร";
                })
            )];

            // ฆาตกรเลือกฆ่าใคร (ถ้ามี)
            const murdererVote = room.murdererKillVote; // { voterId, targetId }

            // รายการผู้ถูกเลือกฆ่า พร้อม killer type
            // ถ้าหมาป่ากับฆาตกรเลือกคนเดียวกัน → ฆาตกรเป็นคนฆ่า
            const killResults = {}; // targetId → "wolf" | "murderer"

            if (wolfChosenTargets.length > 0) {
                // เลือก 1 เป้าจากหมาป่า (ถ้าเสมอกัน random)
                const wolfFinalId = wolfChosenTargets.length === 1
                    ? wolfChosenTargets[0]
                    : wolfChosenTargets[Math.floor(Math.random() * wolfChosenTargets.length)];
                killResults[wolfFinalId] = "wolf";
            }

            if (murdererVote) {
                const mtarget = room.players.find((p) => p.id === murdererVote.targetId);
                if (mtarget && mtarget.alive) {
                    // ฆาตกรเลือกคนเดียวกับหมาป่า → ฆาตกรชนะ (override)
                    // ฆาตกรเลือกหมาป่า → ฆ่าได้ปกติ
                    killResults[murdererVote.targetId] = "murderer";
                }
            }

            // ตรวจว่าหมาป่าเลือกฆาตกร → หมาป่าฆ่าฆาตกรไม่ตาย ส่ง wolf chat แจ้ง
            Object.entries(killResults).forEach(([targetId, killer]) => {
                const target = room.players.find((p) => p.id === targetId);
                if (!target) return;

                if (killer === "wolf" && target.role === "ฆาตกร") {
                    // หมาป่าฆ่าฆาตกรไม่ตาย
                    const failMsg = {
                        name: "เกม",
                        text: `ไม่สามารถฆ่าผู้เล่น...${target.name} ได้`,
                        type: "wolf",
                        isSystem: true,
                    };
                    room.wolfChatHistory = room.wolfChatHistory || [];
                    room.wolfChatHistory.push(failMsg);
                    room.players.forEach((p) => {
                        if (WOLF_ROLES.has(p.role) || p.id === room.host) {
                            io.to(p.id).emit("chat_message", failMsg);
                        }
                    });
                    return;
                }

                // ติ๊ก killed พร้อมเก็บ killerType ไว้แสดงตอน resolve
                target.killed = true;
                target.killedBy = killer; // "wolf" หรือ "murderer"
            });
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // CAST WOLF KILL
    // ----------------------------------------------------------------
    socket.on("cast_wolf_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.wolfKillMode) return;

        const voter = room.players.find((p) => p.id === socket.id);
        if (!voter || !voter.alive || voter.isHost) return;
        if (!WOLF_ROLES.has(voter.role)) return;

        room.wolfKillVotes = room.wolfKillVotes || {};

        if (!targetId) {
            delete room.wolfKillVotes[socket.id];
        } else {
            if (targetId === socket.id) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || !target.alive) return;
            if (WOLF_ROLES.has(target.role)) return; // ห้ามหมาป่าเลือกฆ่ากันเอง
            // หมาป่าฆ่าฆาตกรได้ (แต่ไม่มีผลจริง — จะถูก block ตอน resolve)
            room.wolfKillVotes[socket.id] = targetId;
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // CAST MURDERER KILL
    // ----------------------------------------------------------------
    socket.on("cast_murderer_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.wolfKillMode) return;

        const voter = room.players.find((p) => p.id === socket.id);
        if (!voter || !voter.alive || voter.isHost) return;
        if (voter.role !== "ฆาตกร") return;

        if (!targetId) {
            room.murdererKillVote = null;
        } else {
            if (targetId === socket.id) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || !target.alive) return;
            room.murdererKillVote = { voterId: socket.id, targetId };
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // RESOLVE NIGHT — สรุปผลกลางคืน
    // ----------------------------------------------------------------
    socket.on("resolve_night", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;

        const protectRoles = new Set(["หมอ", "บอดี้การ์ด"]);
        const silenceRoles = new Set(["ยายแก่"]);

        function findProtectorsOf(targetId) {
            if (!room.selectedTargets) return [];
            return Object.keys(room.selectedTargets)
                .filter((sid) => room.selectedTargets[sid] === targetId)
                .map((sid) => room.players.find((p) => p.id === sid))
                .filter((s) => s && protectRoles.has(s.role));
        }

        const nightMessages = [];
        const wolfChatMessages = [];
        const privateProtectMessages = []; // { playerId, text }
        const allCascadeDeaths = [];

        room.players.forEach((p) => {
            if (!p.killed) return;
            if (!p.alive) return; // ตายไปแล้วก่อนในลูปเดียวกัน → ข้าม

            if (p.protected) {
                // รอด
                findProtectorsOf(p.id).forEach((protector) => {
                    privateProtectMessages.push({
                        playerId: protector.id,
                        text: `การป้องกันของคุณได้ช่วย ${p.name} ไว้`,
                    });
                });
                wolfChatMessages.push({
                    name: "เกม",
                    text: `ไม่สามารถฆ่า ${p.name} ได้`,
                    type: "wolf",
                    isSystem: true,
                });
            } else {
                // ตาย
                p.alive = false;
                allCascadeDeaths.push(...cleanupAfterDeath(room, p));
                const killerType = p.killedBy || "wolf";
                const killText = killerType === "murderer"
                    ? `ฆาตกรได้ฆ่า...${p.name}`
                    : `เหล่ามนุษย์หมาป่าได้ฆ่า ${p.name}`;
                nightMessages.push({
                    name: "เกม",
                    text: killText,
                    type: "global",
                    isSystem: true,
                });
            }
        });

        // ล้าง selectedTargets ของ special roles
        if (room.selectedTargets) {
            Object.keys(room.selectedTargets).forEach((selectorId) => {
                const selector = room.players.find((p) => p.id === selectorId);
                if (!selector) return;
                if (!protectRoles.has(selector.role) && !silenceRoles.has(selector.role)) return;

                const targetId = room.selectedTargets[selectorId];
                const target = room.players.find((p) => p.id === targetId);
                if (target && protectRoles.has(selector.role)) target.protected = false;
                // silenced: ไม่ล้างตรงนี้ — จะล้างตอน start_night
                delete room.selectedTargets[selectorId];
            });
        }

        // ล้าง killed/protected ทุกคน (silenced คงไว้จนกว่าจะกด start_night)
        room.players.forEach((p) => {
            p.killed = false;
            p.killedBy = null;
            p.protected = false;
        });
        room.murdererKillVote = null;

        room.dayCount = (room.dayCount || 0) + 1;
        room.isNight = false;

        room.globalChatHistory = room.globalChatHistory || [];

        const dayAnnounceMsg = {
            name: "เกม",
            text: `☀️ เริ่มการประชุมวันที่ ${room.dayCount}`,
            type: "global",
            isSystem: true,
        };
        room.globalChatHistory.push(dayAnnounceMsg);
        io.to(roomId).emit("chat_message", dayAnnounceMsg);

        // ประกาศคนที่ถูกใบ้
        room.players
            .filter((p) => !p.isHost && p.silenced)
            .forEach((p) => {
                const msg = {
                    name: "เกม",
                    text: `🤐 ${p.name} ถูกใบ้ ทำให้เขาไม่สามารถพูดได้ในการประชุมนี้`,
                    type: "global",
                    isSystem: true,
                };
                room.globalChatHistory.push(msg);
                io.to(roomId).emit("chat_message", msg);
            });

        // ผลกลางคืน
        if (nightMessages.length === 0) {
            const msg = {
                name: "เกม",
                text: "คืนนี้ผ่านไปอย่างสงบ ไม่มีใครเสียชีวิต",
                type: "global",
                isSystem: true,
            };
            room.globalChatHistory.push(msg);
            io.to(roomId).emit("chat_message", msg);
        } else {
            nightMessages.forEach((msg) => {
                room.globalChatHistory.push(msg);
                io.to(roomId).emit("chat_message", msg);
            });
        }

        // แจ้งหมาป่าว่าฆ่าไม่สำเร็จ
        if (wolfChatMessages.length > 0) {
            room.wolfChatHistory = room.wolfChatHistory || [];
            wolfChatMessages.forEach((msg) => {
                room.wolfChatHistory.push(msg);
                room.players.forEach((p) => {
                    if (WOLF_ROLES.has(p.role) || p.id === room.host) {
                        io.to(p.id).emit("chat_message", msg);
                    }
                });
            });
        }

        // แจ้งผู้ปกป้องส่วนตัว
        privateProtectMessages.forEach(({ playerId, text }) => {
            io.to(playerId).emit("chat_message", {
                name: "เกม",
                text,
                type: "private",
                isSystem: true,
            });
        });

        announceCascadeDeaths(room, roomId, allCascadeDeaths);
        checkGameEndGeneral(room, roomId);
        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // START NIGHT
    // ----------------------------------------------------------------
    socket.on("start_night", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;

        room.globalChatHistory = room.globalChatHistory || [];

        // ล้าง silenced และประกาศในแชท
        const wasSilenced = room.players.filter((p) => !p.isHost && p.silenced);
        room.players.forEach((p) => { p.silenced = false; });

        if (wasSilenced.length > 0) {
            const liftMsg = {
                name: "เกม",
                text: `🔊 คำสาปใบ้ได้สิ้นสุดลงแล้ว — ${wasSilenced.map((p) => p.name).join(", ")} กลับมาพูดได้ตามปกติ`,
                type: "global",
                isSystem: true,
            };
            room.globalChatHistory.push(liftMsg);
            io.to(roomId).emit("chat_message", liftMsg);
        }

        room.nightCount = (room.nightCount || 0) + 1;
        room.isNight = true;

        const nightMsg = {
            name: "เกม",
            text: `🌙 เริ่มคืนที่ ${room.nightCount}`,
            type: "wolf",
            isSystem: true,
        };
        room.wolfChatHistory = room.wolfChatHistory || [];
        room.wolfChatHistory.push(nightMsg);

        room.players.forEach((p) => {
            if (WOLF_ROLES.has(p.role) || p.id === room.host) {
                io.to(p.id).emit("chat_message", nightMsg);
            }
        });

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // SELECT TARGET (ความสามารถกลางคืน: หมอ/บอดี้การ์ด/ยายแก่/ลูกหมาป่า)
    // ----------------------------------------------------------------
    socket.on("select_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.selectedTargets = room.selectedTargets || {};

        const protectRoles = new Set(["หมอ", "บอดี้การ์ด"]);
        const silenceRoles = new Set(["ยายแก่"]);
        const selector = room.players.find((p) => p.id === socket.id);
        if (!selector) return;

        const isProtector = protectRoles.has(selector.role);
        const isSilencer  = silenceRoles.has(selector.role);

        if (!targetId) {
            // ยกเลิกการเลือก
            const prevTargetId = room.selectedTargets[socket.id];
            if (prevTargetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) {
                    if (isProtector) prevTarget.protected = false;
                    if (isSilencer)  prevTarget.silenced  = false;
                }
            }
            delete room.selectedTargets[socket.id];
        } else {
            if (targetId === socket.id) return;
            const targetPlayer = room.players.find((p) => p.id === targetId);
            if (!targetPlayer || !targetPlayer.alive) return;

            // ลูกหมาป่าห้ามเลือกหมาป่าด้วยกัน
            if (selector.role === "ลูกหมาป่า" && WOLF_ROLES.has(targetPlayer.role)) return;

            // ถอด flag จาก target เดิมก่อนเปลี่ยน
            const prevTargetId = room.selectedTargets[socket.id];
            if (prevTargetId && prevTargetId !== targetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) {
                    if (isProtector) prevTarget.protected = false;
                    if (isSilencer)  prevTarget.silenced  = false;
                }
            }

            if (isProtector) targetPlayer.protected = true;
            if (isSilencer)  targetPlayer.silenced  = true;
            room.selectedTargets[socket.id] = targetId;
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // SELECT SHIELD (หมาป่าพิทักษ์ — วางโล่ป้องกันการประหาร)
    // ----------------------------------------------------------------
    socket.on("select_shield", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.voteMode) return;

        const selector = room.players.find((p) => p.id === socket.id);
        if (!selector || !selector.alive || selector.isHost) return;
        if (selector.role !== "หมาป่าพิทักษ์") return;
        if (!(selector.guardianShieldAvailable > 0)) return;

        room.shieldTargets = room.shieldTargets || {};

        if (!targetId) {
            delete room.shieldTargets[socket.id];
        } else {
            // ตรวจสอบเป้าหมาย (ยกเว้นตัวเอง ซึ่งรู้อยู่แล้วว่ามีชีวิต)
            if (targetId !== socket.id) {
                const targetPlayer = room.players.find((p) => p.id === targetId);
                if (!targetPlayer || !targetPlayer.alive) return;
            }

            // กดคนเดิมซ้ำ = ยกเลิก
            if (room.shieldTargets[socket.id] === targetId) {
                delete room.shieldTargets[socket.id];
            } else {
                room.shieldTargets[socket.id] = targetId;
            }
        }

        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // SEND CHAT
    // ----------------------------------------------------------------
    socket.on("send_chat", ({ roomId, text, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || !player.alive) return;
        if (typeof text !== "string") return;

        const msg = text.trim();
        if (msg.length === 0 || msg.length > 200) return;

        // WOLF CHAT
        if (type === "wolf") {
            if (!WOLF_ROLES.has(player.role)) return;

            const wolfMsg = { name: player.name, text: msg, type: "wolf" };
            room.wolfChatHistory = room.wolfChatHistory || [];
            room.wolfChatHistory.push(wolfMsg);

            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role) || p.id === room.host) {
                    io.to(p.id).emit("chat_message", wolfMsg);
                }
            });
            return;
        }

        // GLOBAL CHAT
        if (room.isNight) return;   // กลางคืน: ห้ามส่งแชทรวม
        if (player.silenced) return; // โดนใบ้: ห้ามส่ง

        const globalMsg = { name: player.name, text: msg, type: "global" };
        room.globalChatHistory = room.globalChatHistory || [];
        room.globalChatHistory.push(globalMsg);
        io.to(roomId).emit("chat_message", globalMsg);
    });

    // ----------------------------------------------------------------
    // HOST CHAT
    // ----------------------------------------------------------------
    socket.on("host_chat", ({ roomId, text, type }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        if (typeof text !== "string") return;

        const msg = text.trim();
        if (!msg) return;

        if (type === "wolf") {
            const wolfMsg = { name: "HOST", text: msg, type: "wolf", isHost: true };
            room.wolfChatHistory = room.wolfChatHistory || [];
            room.wolfChatHistory.push(wolfMsg);
            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role) || p.id === room.host) {
                    io.to(p.id).emit("chat_message", wolfMsg);
                }
            });
            return;
        }

        const globalMsg = { name: "HOST", text: msg, type: "global", isHost: true };
        room.globalChatHistory = room.globalChatHistory || [];
        room.globalChatHistory.push(globalMsg);
        io.to(roomId).emit("chat_message", globalMsg);
    });

    // ----------------------------------------------------------------
    // TOGGLE WIN CONDITION (โหมดผู้ทดสอบ)
    // ----------------------------------------------------------------
    socket.on("toggle_win_condition", ({ roomId, condition }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;
        if (!WIN_CONDITIONS.includes(condition)) return;

        room.testerConditions = room.testerConditions ||
            Object.fromEntries(WIN_CONDITIONS.map((k) => [k, true]));
        room.testerConditions[condition] = !room.testerConditions[condition];
        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // CONFIRM CONTINUE — ผู้เล่นกด "ดำเนินการต่อ" หลังเกมจบ
    // ----------------------------------------------------------------
    socket.on("confirm_continue", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameOver) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || player.isHost) return;

        room.continueReady = room.continueReady || {};
        room.continueReady[socket.id] = true;
        io.to(roomId).emit("room_update", room);
    });

    // ----------------------------------------------------------------
    // KICK PLAYER
    // ----------------------------------------------------------------
    socket.on("kick_player", ({ roomId, playerId }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;

        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;

        io.to(playerId).emit("kicked");

        // ยกเลิก pending removal ที่มีอยู่
        if (pendingRemovals[player.token]) {
            clearTimeout(pendingRemovals[player.token].timer);
            delete pendingRemovals[player.token];
        }

        // ล้าง targets/votes/shield ที่เกี่ยวกับผู้เล่นนี้
        const cleanMap = (map) => {
            if (!map) return;
            Object.keys(map).forEach((sid) => {
                if (map[sid] === playerId) delete map[sid];
            });
            delete map[playerId];
        };
        cleanMap(room.selectedTargets);
        cleanMap(room.shieldTargets);
        cleanMap(room.votes);
        cleanMap(room.wolfKillVotes);

        // ล้าง murdererKillVote ถ้าเกี่ยวกับผู้เล่นนี้
        if (room.murdererKillVote &&
            (room.murdererKillVote.voterId === playerId || room.murdererKillVote.targetId === playerId)) {
            room.murdererKillVote = null;
        }

        // ถอด protected ถ้า player นี้เป็น protector
        const protectRoles = new Set(["หมอ", "บอดี้การ์ด"]);
        if (protectRoles.has(player.role) && room.selectedTargets) {
            const prevTargetId = room.selectedTargets[playerId];
            if (prevTargetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) prevTarget.protected = false;
            }
        }

        room.players = room.players.filter((p) => p.id !== playerId);

        if (room.players.length === 0) {
            delete rooms[roomId];
            clearGameOverTimer(roomId);
        } else {
            checkGameEndGeneral(room, roomId);
            io.to(roomId).emit("room_update", room);
        }

        broadcastSuggestedRoom();
    });

    // ----------------------------------------------------------------
    // HOST PRIVATE MSG
    // ----------------------------------------------------------------
    socket.on("host_private_msg", ({ roomId, playerId, text }) => {
        const room = rooms[roomId];
        if (!room || socket.id !== room.host) return;

        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;
        if (typeof text !== "string") return;

        const msg = text.trim();
        if (!msg) return;

        // ตรวจว่าข้อความอยู่ใน preset ของบทนั้นจริงๆ
        const presets = roles[player.role]?.messages || [];
        if (!presets.includes(msg)) return;

        io.to(player.id).emit("chat_message", {
            name: "HOST",
            text: msg,
            type: "private",
            isHost: true,
        });

        // ส่งสำเนาให้โฮสต์เห็นด้วย
        if (socket.id !== player.id) {
            io.to(room.host).emit("chat_message", {
                name: `HOST → ${player.name}`,
                text: msg,
                type: "private",
                isHost: true,
            });
        }

        // ผู้ถูกสาป + ข้อความ "กลายเป็นหมาป่า" → ย้ายทีม
        if (player.role === "ผู้ถูกสาป" && msg === "คุณได้กลายเป็นหมาป่าแล้ว") {
            player.role = "หมาป่า";
            player.displayRole = "หมาป่า (ผู้ถูกสาป)";

            io.to(player.id).emit("your_role", {
                role: player.role,
                displayRole: player.displayRole,
                huntTarget: player.huntTarget,
                huntTargetId: player.huntTargetId || null,
                roleInfo: roleDescription[player.role] || null,
                silent: true,
            });

            if (room.wolfChatHistory?.length) {
                io.to(player.id).emit("wolf_chat_history", room.wolfChatHistory);
            }

            checkGameEndGeneral(room, roomId);
            io.to(roomId).emit("room_update", room);
        }
    });

    // ----------------------------------------------------------------
    // CLOSE ROOM (โฮสต์กดปุ่มปิดห้องเอง)
    // ----------------------------------------------------------------
    function closeRoom(roomId, reason) {
        const room = rooms[roomId];
        if (!room) return;

        io.to(roomId).emit("room_closed", { reason });

        room.players.forEach((p) => {
            io.sockets.sockets.get(p.id)?.leave(roomId);
            if (pendingRemovals[p.token]) {
                clearTimeout(pendingRemovals[p.token].timer);
                delete pendingRemovals[p.token];
            }
        });

        delete rooms[roomId];
        clearGameOverTimer(roomId);
        broadcastSuggestedRoom();
    }

    socket.on("close_room", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id !== room.host) return;
        closeRoom(roomId, "host_closed");
    });

    // ----------------------------------------------------------------
    // DISCONNECT
    // ----------------------------------------------------------------
    socket.on("disconnect", () => {
        for (const id in rooms) {
            const room = rooms[id];
            const player = room.players.find((p) => p.id === socket.id);
            if (!player) continue;

            player.disconnected = true;
            io.to(id).emit("room_update", room);

            // โฮสต์: ห้องไม่ถูกลบอัตโนมัติ — ปิดได้แค่ตอนกดปุ่ม "ปิดห้อง"
            if (player.isHost) {
                broadcastSuggestedRoom();
                continue;
            }

            // ผู้เล่นทั่วไป: รอ 1 นาที แล้วเปลี่ยนเป็น offline (ไม่ลบกริด)
            if (pendingRemovals[player.token]) {
                clearTimeout(pendingRemovals[player.token].timer);
            }

            pendingRemovals[player.token] = {
                roomId: id,
                timer: setTimeout(() => {
                    delete pendingRemovals[player.token];

                    const stillRoom = rooms[id];
                    if (!stillRoom) return;

                    const stillPlayer = stillRoom.players.find((p) => p.token === player.token);
                    if (!stillPlayer || !stillPlayer.disconnected) return;

                    stillPlayer.disconnected = false;
                    stillPlayer.offline = true;
                    io.to(id).emit("room_update", stillRoom);
                    broadcastSuggestedRoom();
                }, RECONNECT_GRACE_MS),
            };
        }

        broadcastSuggestedRoom();
    });
});

// ============================================================
server.listen(process.env.PORT || 3000, () => {
    console.log("server running on port", process.env.PORT || 3000);
});
