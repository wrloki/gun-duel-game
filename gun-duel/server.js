/*
 * ============================================================
 *  server.js —— 游戏服务器（阶段5：4人对战 + 双命制 + 开镜 + 大地图）
 * ============================================================
 * 房间流程：创建/加入 → 大厅(显示玩家列表) → 玩家准备 → 房主开始 → 对战 → 回大厅
 *
 * 事件一览：
 *   createRoom  { name, roomId? }  创建房间（可手动指定房间号）
 *   joinRoom    { roomId, name }   加入房间（满 4 人返回「房间已满」）
 *   setReady    { ready }          准备 / 取消准备
 *   startGame                      房主开始游戏（需满2人且都准备）
 *   move / shoot / leaveRoom       对战相关
 *
 * 对战规则：
 *   - 每人一局 2 条命，第一条命被打空 → 在随机出生点复活
 *   - 第二条命也耗尽 → 本局淘汰（观战），直到只剩最后一人
 * ============================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 武器数据（伤害由服务器说了算）
const WEAPONS = {
  smg:    { damage: 10,  range: 60  },
  rifle:  { damage: 18,  range: 100 },
  sniper: { damage: 40,  range: 160 },
};

const rooms = new Map();
const MAX_PLAYERS = 4;
const MAX_HP = 120;         // 每条命的血量（提高容错，不会被两枪击倒）
const START_LIVES = 2;      // 一局 2 条命

// 出生点（8 个，分布在整张地图四周，开局分散不扎堆；复活时挑离敌人最远的一个）
const SPAWNS = [
  { x: -30, z: -30, yaw:  Math.PI / 4 },
  { x:  30, z: -30, yaw: -Math.PI / 4 },
  { x: -30, z:  30, yaw:  Math.PI * 3 / 4 },
  { x:  30, z:  30, yaw: -Math.PI * 3 / 4 },
  { x:   0, z: -40, yaw:  Math.PI },
  { x:   0, z:  40, yaw:  0 },
  { x: -40, z:   0, yaw:  Math.PI / 2 },
  { x:  40, z:   0, yaw: -Math.PI / 2 },
];

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id = '';
  do {
    id = '';
    for (let i = 0; i < 4; i++) id += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
  } while (rooms.has(id));
  return id;
}

function makePlayer(socket, data, index) {
  const spawn = SPAWNS[index] || SPAWNS[0];
  return {
    id: socket.id,
    name: (data && data.name && String(data.name).trim()) || '玩家',
    ready: false,                 // 是否已准备
    team: null,                   // 队伍：'red' | 'blue' | null（自由混战）
    position: { x: spawn.x, y: 0, z: spawn.z },
    rotation: spawn.yaw,
    hp: MAX_HP,
    lives: START_LIVES,           // 剩余生命数（一局 2 条命）
    eliminated: false,            // 是否已被淘汰
  };
}

// 生成"给客户端看"的玩家列表（不含位置等内部数据）
function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, ready: p.ready, team: p.team,
  }));
}

// 把大厅信息广播给房间里所有人（玩家列表变化时调用）
function broadcastRoom(room) {
  io.to(room.id).emit('roomUpdate', {
    roomId: room.id,
    hostId: room.hostId,
    players: publicPlayers(room),
  });
}

// 复活时挑选出生点：离所有存活敌人最远的一个，避免刚复活就被蹲点
function pickRespawnSpawn(room, excludeId) {
  const others = [...room.players.values()].filter((p) => p.id !== excludeId && !p.eliminated);
  let best = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  let bestDist = -1;
  for (const s of SPAWNS) {
    let minDist = Infinity;
    for (const o of others) {
      const d = Math.hypot(s.x - o.position.x, s.z - o.position.z);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestDist) { bestDist = minDist; best = s; }
  }
  return best;
}

// 离开房间（断开 / 主动退出都用）
function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    room.players.delete(socket.id);
    socket.leave(roomId);
    // 房主走了就把房主身份交给剩下的第一个人
    if (room.hostId === socket.id && room.players.size > 0) {
      room.hostId = room.players.keys().next().value;
    }
    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log('房间', roomId, '已关闭');
    } else {
      // 对局进行中有人离开 → 房间退回大厅，重置准备/血量/生命
      if (room.state === 'playing') {
        room.state = 'lobby';
        room.players.forEach((p) => { p.hp = MAX_HP; p.lives = START_LIVES; p.eliminated = false; p.ready = false; });
      }
      socket.to(roomId).emit('playerLeft', { id: socket.id });
      broadcastRoom(room);
    }
  }
  socket.data.roomId = null;
}

io.on('connection', (socket) => {
  console.log('有玩家连上了：', socket.id);

  // --- 创建房间（可手动指定房间号，留空则自动生成） ---
  socket.on('createRoom', (data, callback) => {
    let roomId = (data && data.roomId && String(data.roomId).trim().toUpperCase()) || '';
    if (roomId) {
      if (!/^[A-Z0-9]{4}$/.test(roomId)) {
        return callback({ success: false, message: '房间号需要是4位字母或数字' });
      }
      if (rooms.has(roomId)) {
        return callback({ success: false, message: '该房间号已被使用，换一个吧' });
      }
    } else {
      roomId = generateRoomId();
    }

    const room = { id: roomId, hostId: socket.id, state: 'lobby', players: new Map() };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    const player = makePlayer(socket, data, 0);
    room.players.set(socket.id, player);

    callback({
      success: true, roomId, youId: socket.id, hostId: room.hostId,
      players: publicPlayers(room),
    });
    console.log('创建房间：', roomId);
  });

  // --- 加入房间 ---
  socket.on('joinRoom', (data, callback) => {
    const room = rooms.get((data.roomId || '').toUpperCase());
    if (!room) return callback({ success: false, message: '房间不存在，请检查房间号' });
    if (room.state !== 'lobby') return callback({ success: false, message: '对局已开始，无法加入' });
    if (room.players.size >= MAX_PLAYERS) return callback({ success: false, message: '房间已满' });

    socket.join(room.id);
    socket.data.roomId = room.id;

    const index = room.players.size;
    const player = makePlayer(socket, data, index);
    room.players.set(socket.id, player);

    callback({
      success: true, roomId: room.id, youId: socket.id, hostId: room.hostId,
      players: publicPlayers(room),
    });
    broadcastRoom(room);
    console.log(socket.id, '加入了房间', room.id);
  });

  // --- 准备 / 取消准备 ---
  socket.on('setReady', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!data.ready;
    broadcastRoom(room);
  });

  // --- 选择队伍（仅大厅阶段；开局后锁定不能更换） ---
  socket.on('setTeam', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const team = data && data.team;
    p.team = (team === 'red' || team === 'blue') ? team : null;   // null = 自由混战
    broadcastRoom(room);
  });

  // --- 房主开始游戏 ---
  socket.on('startGame', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'lobby') return;
    if (room.hostId !== socket.id) return;                  // 只有房主能开始
    if (room.players.size < 2) return;                      // 至少 2 人才能开始
    for (const p of room.players.values()) if (!p.ready) return; // 必须都准备好

    room.state = 'playing';
    // 分配出生点、重置血量/生命、清空准备状态
    const spawns = {};
    const teams = {};
    let i = 0;
    for (const p of room.players.values()) {
      p.hp = MAX_HP;
      p.lives = START_LIVES;
      p.eliminated = false;
      p.ready = false;
      p.position = { x: SPAWNS[i].x, y: 0, z: SPAWNS[i].z };
      p.rotation = SPAWNS[i].yaw;
      spawns[p.id] = SPAWNS[i];
      teams[p.id] = p.team || null;
      i++;
    }
    io.to(roomId).emit('gameStart', { spawns, teams });
    console.log('房间', roomId, '开始游戏');
  });

  // --- 移动 ---
  socket.on('move', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) { p.position = data.position; p.rotation = data.rotation; }
    socket.to(roomId).emit('playerMove', {
      id: socket.id, position: data.position, rotation: data.rotation,
    });
  });

  // --- 射击 ---
  socket.on('shoot', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.state !== 'playing') return;         // 大厅里不能开枪
    const weapon = WEAPONS[data.weapon];
    if (!weapon) return;

    socket.to(roomId).emit('shotFired', { shooterId: socket.id, weapon: data.weapon });

    if (!data.targetId) return;
    const shooter = room.players.get(socket.id);
    const target = room.players.get(data.targetId);
    if (!shooter || !target) return;
    if (target.hp <= 0 || target.eliminated) return;
    // 组队：同色队友之间子弹无效（不扣血、不扣命）；自由混战 team 为 null，可互相攻击
    if (shooter.team && target.team && shooter.team === target.team) return;

    const dx = target.position.x - shooter.position.x;
    const dz = target.position.z - shooter.position.z;
    if (Math.hypot(dx, dz) > weapon.range + 5) return;

    target.hp = Math.max(0, target.hp - weapon.damage);
    io.to(roomId).emit('healthUpdate', { id: target.id, hp: target.hp, damage: weapon.damage });

    if (target.hp <= 0) {
      target.lives -= 1;
      if (target.lives > 0) {
        // 还有命 → 在随机（离敌人最远）出生点复活
        const spawn = pickRespawnSpawn(room, target.id);
        target.hp = MAX_HP;
        target.position = { x: spawn.x, y: 0, z: spawn.z };
        target.rotation = spawn.yaw;
        io.to(roomId).emit('respawn', {
          id: target.id, position: target.position, rotation: target.rotation,
          hp: target.hp, lives: target.lives,
        });
      } else {
        // 第二条命耗尽 → 淘汰
        target.eliminated = true;
        io.to(roomId).emit('eliminated', { id: target.id, lives: 0 });

        // 判断胜负：按"阵营"分组 —— 红队/蓝队各算一组，自由混战玩家每人算独立一组
        const alive = [...room.players.values()].filter((p) => !p.eliminated);
        const factions = new Set(alive.map((p) => (p.team ? p.team : 'ffa:' + p.id)));
        if (factions.size <= 1) {
          let winnerId = null, winnerTeam = null;
          if (alive.length === 1) {
            winnerId = alive[0].id;
            winnerTeam = alive[0].team || null;
          } else if (alive.length > 1) {
            winnerTeam = alive[0].team;   // 剩下一整队存活
          }
          io.to(roomId).emit('matchEnd', { winnerId, winnerTeam });
          // 回到大厅：重置状态（队伍保留，方便下一局直接开）
          room.state = 'lobby';
          room.players.forEach((p) => { p.hp = MAX_HP; p.lives = START_LIVES; p.eliminated = false; p.ready = false; });
          broadcastRoom(room);
          console.log('对局结束，胜利方：', winnerTeam || winnerId || '无人');
        }
      }
    }
  });

  socket.on('leaveRoom', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log('============================================');
  console.log('  多人3D枪战 · 服务器已启动！');
  console.log('  电脑浏览器打开： http://localhost:' + PORT);
  console.log('  （阶段5：4人对战 + 双命制 + 开镜 + 大地图）');
  console.log('============================================');
});
