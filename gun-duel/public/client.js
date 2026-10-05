/*
 * ============================================================
 *  client.js —— 前端游戏逻辑（阶段5：4人对战 + 双命制 + 开镜 + 大地图）
 * ============================================================
 * 本次改动：
 *   1. 左右方向修正：鼠标/触屏转视角、WASD/摇杆左右移动，全部恢复正常（不再反向）
 *   2. 房间 4 人上限：满 4 人弹「房间已满」，HUD/大厅显示 人数/4
 *   3. 地图放大 + 更多掩体，出生点分散，掩体挡子弹
 *   4. 操作：R 换弹（冷却），1/2/3 换枪，Q 开镜；手机加「开镜」按钮（不支持的枪自动隐藏）
 *   5. 弹药系统：每把枪独立弹匣/备弹，打空需换弹
 *   6. 生命机制：一局 2 条命，第一次阵亡随机复活，第二条命耗尽才淘汰
 *   7. 枪械差异化开镜：冲锋枪=抵肩瞄准(轻微放大+准星收缩成点)，步枪=红点(小幅放大)，狙击枪=高倍镜(大幅放大+减速)
 *   8. 血量提高到 120，提高对战容错
 *
 * 控制方式：
 *   手机：左摇杆移动，右半屏转视角，右下按钮 射击/跳跃/换枪/换弹/开镜
 *   电脑：WASD 移动，鼠标转视角（点击画面锁定），左键射击，空格跳，1/2/3 换枪，R 换弹，Q 开镜
 * ============================================================
 */

import * as THREE from 'three';

const socket = io();

// ---------- 1. 场景相关 ----------
let scene, camera, renderer, clock;
let sceneReady = false;
let playerPos = new THREE.Vector3();  // 本地玩家脚底位置（第一人称，自己不渲染模型）
let fpsGun = null;                    // 第一人称枪（挂在相机上）
let remotePlayers = new Map();        // 对手（第三人称模型）
let solidMeshes = [];                 // 子弹会撞到的东西（地形+墙+箱子+岩石）
let walls = [];                       // 移动碰撞盒

// 枪口特效
let muzzleLight = null;               // 复用的点光源，模拟枪口照亮周围
let muzzleSprite = null;              // 枪口火焰贴片
let muzzleFlashT = 0;                 // 火焰剩余时间
let flashTexture = null;              // 放射状光晕贴图（枪口火焰 + 命中闪光共用）
let recoil = 0;                       // 开枪后坐力

// 火花粒子 + 拖尾/命中闪光
let sparks = [];
let trails = [];
const sparkGeo = new THREE.SphereGeometry(0.05, 6, 6);

// ---------- 2. 朝向 / 输入 ----------
let yaw = 0, pitch = 0;
const keys = {};
const joyInput = { x: 0, z: 0 };
let fireHeld = false, firePrev = false;

// ---------- 3. 物理 ----------
const MOVE_SPEED = 6;
const GRAVITY = -20;
const JUMP_SPEED = 8;
const PLAYER_RADIUS = 0.4;
const EYE_HEIGHT = 1.6;               // 眼睛离脚底的高度
const BASE_FOV = 60;                  // 基础（腰射）视野
let velY = 0;
let grounded = true;

// ---------- 4. 武器 ----------
const WEAPONS = {
  smg:    { name: '冲锋枪', damage: 10,  fireRate: 90,   range: 60,  auto: true,  spread: 0.05,  magazine: 30, reserve: 120, reloadTime: 1300, scope: 'dot',    zoomFov: 50 },
  rifle:  { name: '步枪',   damage: 18,  fireRate: 220,  range: 100, auto: true,  spread: 0.02,  magazine: 30, reserve: 90,  reloadTime: 1500, scope: 'reddot', zoomFov: 45 },
  sniper: { name: '狙击枪', damage: 40,  fireRate: 1200, range: 160, auto: false, spread: 0.0,   magazine: 8,  reserve: 24,  reloadTime: 2000, scope: 'high',   zoomFov: 26, scopedSpeed: 0.45 },
};
const WEAPON_ORDER = ['smg', 'rifle', 'sniper'];
let weaponIndex = 0;
let lastShotTime = 0;
// 弹药系统：每把枪独立弹匣 + 独立备弹（数组下标与 WEAPON_ORDER 对齐），换弹期间不能开枪
let ammo = WEAPON_ORDER.map((id) => WEAPONS[id].magazine);       // 当前弹匣子弹数
let reserveAmmo = WEAPON_ORDER.map((id) => WEAPONS[id].reserve);  // 备弹数
let reloading = false;
let reloadEndTime = 0;

// ---------- 5. 游戏状态 ----------
const MAX_HP = 120;                   // 每条命的血量（提高容错，不会被两枪击倒）
let myId = null;
let currentRoomId = null;
let appState = 'menu';                // menu | lobby | game
let isHost = false;
let myReady = false;
let matchOver = false;                // 整局结束（只剩一人）
let iAmEliminated = false;            // 我是否已被淘汰（两条命耗尽，观战）
let myHp = MAX_HP;
let myLives = 2;                      // 我的剩余生命数（一局 2 条命）
let enemyHp = new Map();              // 对手血量（id -> hp）
let enemyLives = new Map();           // 对手剩余生命数（id -> lives）
let playerNames = new Map();          // 玩家昵称（id -> name，大厅记录）
let myTeam = null;                    // 我的队伍：'red' | 'blue' | null（自由混战）
let playerTeams = new Map();          // 玩家队伍（id -> 'red'|'blue'|null）
let scoped = false;                   // 是否开镜
let scopeFov = null;                  // 开镜目标视野（FOV）

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function currentWeapon() { return WEAPONS[WEAPON_ORDER[weaponIndex]]; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- 组队辅助 ----------
function teamColorOf(team) {
  if (team === 'red') return 0xe04b3a;   // 红队
  if (team === 'blue') return 0x3a7be0;  // 蓝队
  return 0xf2f2f2;                       // 自由混战：白色
}
function teamName(team) {
  if (team === 'red') return '红队';
  if (team === 'blue') return '蓝队';
  return '混战';
}
function teamCss(team) {
  if (team === 'red') return '#e04b3a';
  if (team === 'blue') return '#3a7be0';
  return '#cfd3da';
}
function isFriendly(id) {
  return !!(myTeam && playerTeams.get(id) === myTeam);
}
function rememberTeams(players) {
  playerTeams.clear();
  players.forEach((p) => playerTeams.set(p.id, p.team || null));
}

// ---------- 6. 地形高度函数（起伏地面，靠近边界平滑降到 0） ----------
function terrainHeight(x, z) {
  const R = 55;
  const d = Math.max(Math.abs(x), Math.abs(z)) / R;
  const falloff = clamp(1 - d, 0, 1);
  const h = Math.sin(x * 0.18) * Math.cos(z * 0.15) * 0.6
          + Math.sin(x * 0.06 + 1.3) * Math.sin(z * 0.08 + 0.5) * 1.0
          + Math.cos(x * 0.11 + 2.0) * 0.4;
  return h * falloff * falloff;
}

// ---------- 7. 初始化 3D 场景 ----------
function initScene() {
  if (sceneReady) return;
  sceneReady = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x86c5e8);
  scene.fog = new THREE.Fog(0x86c5e8, 90, 240);

  camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 300);
  scene.add(camera);   // 关键：把相机加进场景，挂在相机上的枪才会被渲染

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  clock = new THREE.Clock();

  // 光照 + 阴影
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3f5a3f, 0.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
  sun.position.set(20, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -95;  sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95;    sun.shadow.camera.bottom = -95;
  sun.shadow.camera.near = 1;    sun.shadow.camera.far = 240;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // 枪口火焰用的点光源 + 贴片
  muzzleLight = new THREE.PointLight(0xffbb55, 0, 12);
  scene.add(muzzleLight);
  flashTexture = makeFlashTexture();
  muzzleSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flashTexture, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false,
  }));
  muzzleSprite.scale.setScalar(0.3);
  muzzleSprite.visible = false;
  scene.add(muzzleSprite);

  buildMap();

  // 第一人称枪
  fpsGun = createFpsGun();
  camera.add(fpsGun);

  setupDesktopInput();
  setupTouchControls();
}

// 用 canvas 画一个放射状光晕，当作枪口火焰/命中闪光贴图
function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,220,120,0.9)');
  g.addColorStop(1, 'rgba(255,180,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------- 8. 搭建地图 ----------
function buildMap() {
  const ARENA = 55;

  // 起伏地面
  const SEG = 96;
  const groundGeo = new THREE.PlaneGeometry(ARENA * 2, ARENA * 2, SEG, SEG);
  groundGeo.rotateX(-Math.PI / 2);
  const posAttr = groundGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    posAttr.setY(i, terrainHeight(posAttr.getX(i), posAttr.getZ(i)));
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ color: 0x4a8a3a, roughness: 1 })
  );
  ground.receiveShadow = true;
  scene.add(ground);
  solidMeshes.push(ground);

  function addBox(x, z, w, d, h, color) {
    const gy = terrainHeight(x, z);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
    );
    mesh.position.set(x, gy + h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    solidMeshes.push(mesh);
    walls.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  }

  function addRock(x, z, r, color) {
    const gy = terrainHeight(x, z);
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      new THREE.MeshStandardMaterial({ color, roughness: 0.95 })
    );
    mesh.position.set(x, gy + r * 0.6, z);
    mesh.scale.set(1, 0.72, 1);
    mesh.rotation.y = Math.random() * Math.PI;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    solidMeshes.push(mesh);
    const s = r * 0.8;
    walls.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s });
  }

  function addGrass(x, z, n) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: 0.9 });
    for (let i = 0; i < n; i++) {
      const gx = x + (Math.random() - 0.5) * 1.6;
      const gz = z + (Math.random() - 0.5) * 1.6;
      const h = 0.5 + Math.random() * 0.5;
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.08, h, 5), mat);
      blade.position.set(gx, terrainHeight(gx, gz) + h / 2, gz);
      blade.castShadow = true;
      scene.add(blade);
    }
  }

  // 四周围墙（围住整张地图）
  addBox(0, -ARENA, ARENA * 2, 1, 4, 0x6b6b6b);
  addBox(0,  ARENA, ARENA * 2, 1, 4, 0x6b6b6b);
  addBox(-ARENA, 0, 1, ARENA * 2, 4, 0x6b6b6b);
  addBox( ARENA, 0, 1, ARENA * 2, 4, 0x6b6b6b);

  // 中心建筑群（大掩体 + 四向短墙，形成可绕的中庭）
  addBox(0, 0, 5, 5, 3.0, 0x7a7a7a);
  addBox(0, 8, 6, 1.2, 2.6, 0x8a8a8a);
  addBox(0, -8, 6, 1.2, 2.6, 0x8a8a8a);
  addBox(8, 0, 1.2, 6, 2.6, 0x8a8a8a);
  addBox(-8, 0, 1.2, 6, 2.6, 0x8a8a8a);

  // 内圈长墙（十字方向）
  addBox(0, 16, 14, 1.2, 2.8, 0x8a8a8a);
  addBox(0, -16, 14, 1.2, 2.8, 0x8a8a8a);
  addBox(16, 0, 1.2, 14, 2.8, 0x8a8a8a);
  addBox(-16, 0, 1.2, 14, 2.8, 0x8a8a8a);

  // 中圈长墙
  addBox(0, 28, 18, 1.2, 2.8, 0x8a8a8a);
  addBox(0, -28, 18, 1.2, 2.8, 0x8a8a8a);
  addBox(28, 0, 1.2, 18, 2.8, 0x8a8a8a);
  addBox(-28, 0, 1.2, 18, 2.8, 0x8a8a8a);

  // 错落断墙（斜向掩体，方便拉扯）
  addBox(12, 22, 10, 1.2, 2.6, 0x999999);
  addBox(-12, -22, 10, 1.2, 2.6, 0x999999);
  addBox(22, 12, 1.2, 10, 2.6, 0x999999);
  addBox(-22, -12, 1.2, 10, 2.6, 0x999999);
  addBox(12, -22, 10, 1.2, 2.6, 0x999999);
  addBox(-12, 22, 10, 1.2, 2.6, 0x999999);
  addBox(22, -12, 1.2, 10, 2.6, 0x999999);
  addBox(-22, 12, 1.2, 10, 2.6, 0x999999);

  // 木箱群（掩体 + 挡子弹）
  addBox(5, 5, 1.6, 1.6, 1.6, 0xb0724a);
  addBox(-5, -5, 1.6, 1.6, 1.6, 0xb0724a);
  addBox(5, -5, 1.6, 1.6, 1.6, 0x9a6a42);
  addBox(-5, 5, 1.6, 1.6, 1.6, 0x9a6a42);
  addBox(12, 3, 1.6, 1.6, 1.6, 0xb0724a);
  addBox(-12, -3, 1.6, 1.6, 1.6, 0x9a6a42);
  addBox(3, 12, 1.6, 1.6, 1.6, 0xb0724a);
  addBox(-3, -12, 1.6, 1.6, 1.6, 0x9a6a42);
  addBox(20, 20, 1.8, 1.8, 1.8, 0xb0724a);
  addBox(-20, -20, 1.8, 1.8, 1.8, 0x9a6a42);
  addBox(20, -20, 1.8, 1.8, 1.8, 0xb0724a);
  addBox(-20, 20, 1.8, 1.8, 1.8, 0x9a6a42);
  addBox(35, 12, 1.7, 1.7, 1.7, 0xb0724a);
  addBox(-35, -12, 1.7, 1.7, 1.7, 0x9a6a42);
  addBox(12, 35, 1.7, 1.7, 1.7, 0xb0724a);
  addBox(-12, -35, 1.7, 1.7, 1.7, 0x9a6a42);
  addBox(-35, 12, 1.7, 1.7, 1.7, 0xb0724a);
  addBox(35, -12, 1.7, 1.7, 1.7, 0x9a6a42);
  addBox(12, -35, 1.7, 1.7, 1.7, 0xb0724a);
  addBox(-12, 35, 1.7, 1.7, 1.7, 0x9a6a42);
  addBox(8, 30, 1.8, 1.8, 1.8, 0xb0724a);
  addBox(-8, -30, 1.8, 1.8, 1.8, 0x9a6a42);
  addBox(30, 8, 1.8, 1.8, 1.8, 0xb0724a);
  addBox(-30, -8, 1.8, 1.8, 1.8, 0x9a6a42);

  // 岩石群
  addRock(18, 8, 1.3, 0x8a8a8a);
  addRock(-18, -8, 1.4, 0x7f7f7f);
  addRock(8, 18, 1.2, 0x8a8a8a);
  addRock(-8, -18, 1.3, 0x7f7f7f);
  addRock(26, 20, 1.3, 0x8a8a8a);
  addRock(-26, -20, 1.2, 0x7f7f7f);
  addRock(20, 26, 1.4, 0x8a8a8a);
  addRock(-20, -26, 1.2, 0x7f7f7f);
  addRock(34, -6, 1.2, 0x909090);
  addRock(-34, 6, 1.4, 0x808080);
  addRock(6, 34, 1.3, 0x8a8a8a);
  addRock(-6, -34, 1.2, 0x7f7f7f);
  addRock(42, 22, 1.2, 0x909090);
  addRock(-42, -22, 1.3, 0x8a8a8a);
  addRock(22, 42, 1.2, 0x909090);
  addRock(-22, -42, 1.3, 0x8a8a8a);
  addRock(15, -15, 1.1, 0x8a8a8a);
  addRock(-15, 15, 1.3, 0x808080);

  // 草丛（躲藏 / 装饰）
  addGrass(10, 10, 14);
  addGrass(-10, -10, 14);
  addGrass(18, -12, 12);
  addGrass(-18, 12, 12);
  addGrass(6, -20, 10);
  addGrass(-6, 20, 10);
  addGrass(-24, -10, 10);
  addGrass(24, 10, 10);
  addGrass(32, 22, 12);
  addGrass(-32, -22, 12);
  addGrass(22, -32, 10);
  addGrass(-22, 32, 10);
  addGrass(36, -20, 10);
  addGrass(-36, 20, 10);
  addGrass(14, 14, 12);
  addGrass(-14, -14, 12);
}

// ---------- 9. 制作角色（对手的第三人称模型，美化版） ----------
function createCharacter(teamColor, skinColor) {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.6 });
  const outfit = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.6, 4, 12), outfit);
  torso.position.y = 1.05;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 20), skin);
  head.position.y = 1.9;
  head.castShadow = true;
  group.add(head);

  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.29, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    outfit
  );
  helmet.position.y = 1.96;
  group.add(helmet);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.1, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x66e0ff, emissiveIntensity: 0.6 })
  );
  visor.position.set(0, 1.95, 0.2);
  group.add(visor);

  const legGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.6, 8);
  const legL = new THREE.Mesh(legGeo, dark); legL.position.set(-0.15, 0.3, 0);
  const legR = new THREE.Mesh(legGeo, dark); legR.position.set(0.15, 0.3, 0);
  group.add(legL, legR);

  const armGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8);
  const armL = new THREE.Mesh(armGeo, outfit); armL.position.set(-0.44, 1.15, 0);
  const armR = new THREE.Mesh(armGeo, outfit); armR.position.set(0.44, 1.15, 0);
  group.add(armL, armR);
  const handGeo = new THREE.SphereGeometry(0.1, 8, 8);
  const handL = new THREE.Mesh(handGeo, skin); handL.position.set(-0.44, 0.86, 0);
  const handR = new THREE.Mesh(handGeo, skin); handR.position.set(0.44, 0.86, 0);
  group.add(handL, handR);

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.9), dark);
  gun.position.set(0.3, 1.15, 0.55);
  group.add(gun);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.3, 1.15, 1.05);
  group.add(barrel);

  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.18), outfit);
  pack.position.set(0, 1.2, -0.28);
  group.add(pack);

  return group;
}

// ---------- 10. 第一人称枪（挂在相机上，出现在画面右下） ----------
function createFpsGun() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });

  // 枪身
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.5), metal);
  body.position.set(0.16, -0.15, -0.55);
  g.add(body);
  // 枪管
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.35, 8), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.16, -0.14, -0.88);
  g.add(barrel);
  // 瞄准器
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.08), dark);
  sight.position.set(0.16, -0.07, -0.45);
  g.add(sight);
  // 握把
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.06), dark);
  grip.position.set(0.16, -0.25, -0.4);
  grip.rotation.x = 0.3;
  g.add(grip);
  // 弹匣
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.07), dark);
  mag.position.set(0.16, -0.24, -0.6);
  g.add(mag);

  // 枪口参考点（做火焰/弹道用）
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.16, -0.14, -1.05);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// ---------- 11. 生成玩家 ----------
function startFps(spawn) {
  playerPos.set(spawn.x, terrainHeight(spawn.x, spawn.z), spawn.z);
  yaw = spawn.yaw;
  pitch = 0;
  velY = 0;
  grounded = true;
  myHp = MAX_HP; enemyHp.clear();
  myLives = 2; enemyLives.clear();
  matchOver = false;
  iAmEliminated = false;
  scoped = false; scopeFov = null;
  if (camera) camera.fov = BASE_FOV;
  fireHeld = false; firePrev = false;
  recoil = 0;
  lastShotTime = 0;
  ammo = WEAPON_ORDER.map((id) => WEAPONS[id].magazine);
  reserveAmmo = WEAPON_ORDER.map((id) => WEAPONS[id].reserve);
  reloading = false;
  reloadEndTime = 0;
}

function createRemotePlayer(id, x, z, rot) {
  if (remotePlayers.has(id)) return;
  const group = createCharacter(teamColorOf(playerTeams.get(id) || null), 0xf0c8a0);   // 按队伍上色：红/蓝/白
  const y = terrainHeight(x, z);
  group.position.set(x, y, z);
  group.rotation.y = rot;
  group.userData.playerId = id;
  scene.add(group);
  remotePlayers.set(id, {
    group,
    targetPos: new THREE.Vector3(x, y, z),
    targetYaw: rot,
  });
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (rp) {
    scene.remove(rp.group);
    remotePlayers.delete(id);
  }
}

function clearRemotePlayers() {
  remotePlayers.forEach((rp) => scene.remove(rp.group));
  remotePlayers.clear();
}

// 清空上一局留下的粒子/特效（场景和地图保留）
function resetGameState() {
  clearRemotePlayers();
  sparks.forEach((s) => { scene.remove(s); s.material.dispose(); });
  sparks = [];
  trails.forEach((t) => { scene.remove(t.obj); t.mat.dispose(); });
  trails = [];
  if (muzzleSprite) muzzleSprite.visible = false;
  if (muzzleLight) muzzleLight.intensity = 0;
  myHp = MAX_HP; enemyHp.clear();
  myLives = 2; enemyLives.clear();
  matchOver = false;
  iAmEliminated = false;
  scoped = false; scopeFov = null;
  if (camera) camera.fov = BASE_FOV;
  weaponIndex = 0;
  recoil = 0;
  fireHeld = false; firePrev = false;
  ammo = WEAPON_ORDER.map((id) => WEAPONS[id].magazine);
  reserveAmmo = WEAPON_ORDER.map((id) => WEAPONS[id].reserve);
  reloading = false;
  reloadEndTime = 0;
  updateScopeOverlay();
}

// ---------- 12. 碰撞检测 ----------
function circleRectHit(px, pz, box) {
  const cx = Math.max(box.minX, Math.min(px, box.maxX));
  const cz = Math.max(box.minZ, Math.min(pz, box.maxZ));
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS;
}
function isBlocked(px, pz) {
  for (const w of walls) if (circleRectHit(px, pz, w)) return true;
  return false;
}
function tryMove(dx, dz) {
  const nx = playerPos.x + dx;
  if (!isBlocked(nx, playerPos.z)) playerPos.x = nx;
  const nz = playerPos.z + dz;
  if (!isBlocked(playerPos.x, nz)) playerPos.z = nz;
}

// ---------- 13. 跳跃 ----------
function doJump() {
  if (appState !== 'game' || matchOver || iAmEliminated) return;
  if (grounded) {
    velY = JUMP_SPEED;
    grounded = false;
    playJump();
  }
}

// ---------- 14. 射击 ----------
function tryShoot() {
  if (iAmEliminated) return;                   // 已淘汰不能开枪
  const w = currentWeapon();
  if (reloading) return;                       // 换弹中不能开枪
  if (ammo[weaponIndex] <= 0) {                // 弹匣打空：先换弹，不能射击
    startReload();
    return;
  }
  const now = performance.now();
  if (now - lastShotTime < w.fireRate) return;
  lastShotTime = now;
  ammo[weaponIndex]--;                         // 开枪消耗一发子弹
  updateAmmoLabel();

  playShot(WEAPON_ORDER[weaponIndex]);                     // 自己开枪的声音
  const wKey = WEAPON_ORDER[weaponIndex];
  recoil = (wKey === 'sniper') ? 0.22 : (wKey === 'smg' ? 0.06 : 0.12);  // 后坐力

  // 从眼睛沿准星方向打射线
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  if (w.spread > 0) {
    dir.x += (Math.random() - 0.5) * w.spread;
    dir.y += (Math.random() - 0.5) * w.spread;
    dir.z += (Math.random() - 0.5) * w.spread;
    dir.normalize();
  }

  const raycaster = new THREE.Raycaster(origin, dir, 0, w.range);
  const targets = [...solidMeshes];
  remotePlayers.forEach((rp) => { if (!isFriendly(rp.id)) targets.push(rp.group); });   // 队友不挡子弹、不可命中
  const hits = raycaster.intersectObjects(targets, true);

  let hitPlayerId = null;
  let hitPoint;
  if (hits.length > 0) {
    const h = hits[0];
    hitPoint = h.point.clone();
    let obj = h.object;
    while (obj) {
      if (obj.userData && obj.userData.playerId) { hitPlayerId = obj.userData.playerId; break; }
      obj = obj.parent;
    }
  } else {
    hitPoint = origin.clone().add(dir.clone().multiplyScalar(w.range));
  }

  muzzleFlash();                                   // 枪口火焰
  const start = fpsGun.userData.muzzle.getWorldPosition(new THREE.Vector3());
  bulletTrail(start, hitPoint);                    // 子弹拖尾

  if (hitPlayerId) {
    spawnSparks(hitPoint, 0xff5544, 16);           // 打中人：红色火花
    impactFlash(hitPoint);                          // 命中闪光
    showHitIndicator('命中！');
    playHitConfirm();
  } else {
    spawnSparks(hitPoint, 0xffcc66, 10);           // 打墙/地面：黄色火花
    impactFlash(hitPoint);
  }

  // 通知服务器（打没打中都要发，让对手听到枪声）
  socket.emit('shoot', { targetId: hitPlayerId, weapon: WEAPON_ORDER[weaponIndex] });
}

function muzzleFlash() {
  if (!muzzleLight || !fpsGun) return;
  const pos = fpsGun.userData.muzzle.getWorldPosition(new THREE.Vector3());
  muzzleLight.position.copy(pos);
  muzzleLight.intensity = 5;
  muzzleSprite.position.copy(pos);
  muzzleSprite.visible = true;
  muzzleSprite.material.opacity = 1;
  muzzleSprite.scale.setScalar(0.22 + Math.random() * 0.12);  // 火焰大小随机，更有"跳动"感
  muzzleFlashT = 0.06;
}

// 子弹拖尾：一根细长的发光圆柱，从枪口连到命中点，快速淡出
function bulletTrail(start, end) {
  const dir = end.clone().sub(start);
  const len = dir.length();
  if (len < 0.01) return;
  const geo = new THREE.CylinderGeometry(0.012, 0.012, len, 6, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe9a0, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const cyl = new THREE.Mesh(geo, mat);
  cyl.position.copy(start.clone().add(end).multiplyScalar(0.5));
  cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  scene.add(cyl);
  trails.push({ obj: cyl, mat, life: 0.12, maxLife: 0.12 });
}

// 命中闪光：命中点一个发光光晕，快速淡出
function impactFlash(point) {
  const mat = new THREE.SpriteMaterial({
    map: flashTexture, color: 0xffd9a0, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.position.copy(point);
  sp.scale.setScalar(0.7 + Math.random() * 0.4);
  scene.add(sp);
  trails.push({ obj: sp, mat, life: 0.16, maxLife: 0.16 });
}

// 火花粒子：从命中点向四周飞溅
function spawnSparks(point, color, count) {
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    const s = new THREE.Mesh(sparkGeo, mat);
    s.position.copy(point);
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
    s.userData = {
      vel: dir.multiplyScalar(2 + Math.random() * 4),
      life: 0.4 + Math.random() * 0.3,
      maxLife: 0.7,
    };
    sparks.push(s);
    scene.add(s);
  }
}

// ---------- 15. 换枪 ----------
function switchWeapon(i) {
  weaponIndex = i % WEAPON_ORDER.length;
  lastShotTime = 0;
  reloading = false;              // 换枪打断换弹
  scoped = false; scopeFov = null;  // 换枪退出开镜
  updateScopeOverlay();
  updateAdsButton();
  updateWeaponLabel();
  updateAmmoLabel();
}

// 开始换弹（换弹期间不能开枪；弹匣已满或无备弹则不换）
function startReload() {
  if (appState !== 'game' || matchOver || iAmEliminated) return;
  if (reloading) return;
  const w = currentWeapon();
  if (ammo[weaponIndex] >= w.magazine) return;      // 弹匣已满
  if (reserveAmmo[weaponIndex] <= 0) return;        // 无备弹
  reloading = true;
  reloadEndTime = performance.now() + w.reloadTime;
  playReload();
  updateAmmoLabel();
}

// 换弹完成：从备弹里取子弹补满当前弹匣
function finishReload() {
  const w = currentWeapon();
  const need = w.magazine - ammo[weaponIndex];
  const take = Math.min(need, reserveAmmo[weaponIndex]);
  ammo[weaponIndex] += take;
  reserveAmmo[weaponIndex] -= take;
  reloading = false;
  updateAmmoLabel();
}

// ---------- 15b. 开镜（ADS） ----------
function toggleScope() {
  if (appState !== 'game' || matchOver || iAmEliminated) return;
  const w = currentWeapon();
  if (!w.scope) return;                 // 不支持开镜的枪（仅腰射）
  scoped = !scoped;
  scopeFov = scoped ? w.zoomFov : null;
  updateScopeOverlay();
}

function updateScopeOverlay() {
  const overlay = document.getElementById('scope-overlay');
  const w = currentWeapon();
  const on = scoped && w.scope;
  if (overlay) {
    if (on) {
      overlay.className = w.scope;        // 'dot' | 'reddot' | 'high'
      overlay.style.display = 'block';
    } else {
      overlay.style.display = 'none';
    }
  }
  // 高倍镜：藏起手里的枪，只留镜内视野；红点/抵肩瞄准：枪保留
  if (fpsGun) fpsGun.visible = !(scoped && w.scope === 'high');
  // 冲锋枪抵肩瞄准：准星收缩成一个细小瞄准点
  const cross = document.getElementById('crosshair');
  if (cross) cross.classList.toggle('small', scoped && w.scope === 'dot');
}

function updateAdsButton() {
  const btn = document.getElementById('btn-ads');
  if (!btn) return;
  const isTouch = document.body.classList.contains('touch');
  const supports = !!currentWeapon().scope;
  btn.style.display = (isTouch && supports) ? 'flex' : 'none';
}

// ---------- 16. 输入（电脑） ----------
function setupDesktopInput() {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') { e.preventDefault(); doJump(); }
    else if (e.code === 'Digit1') switchWeapon(0);
    else if (e.code === 'Digit2') switchWeapon(1);
    else if (e.code === 'Digit3') switchWeapon(2);
    else if (e.code === 'KeyR') startReload();
    else if (e.code === 'KeyQ') toggleScope();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  document.addEventListener('click', () => {
    if (appState !== 'game' || matchOver) return;
    if (document.pointerLockElement !== renderer.domElement) {
      try { renderer.domElement.requestPointerLock(); } catch (err) {}
    }
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement || appState !== 'game') return;
    yaw -= e.movementX * 0.0022;     // 鼠标右移=向右转
    pitch -= e.movementY * 0.0022;   // 鼠标上移=抬头
    pitch = clamp(pitch, -1.2, 1.2);
  });
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement === renderer.domElement) fireHeld = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) fireHeld = false;
  });
}

// ---------- 17. 输入（手机） ----------
function setupTouchControls() {
  const joyBase = document.getElementById('joystick-base');
  const joyKnob = document.getElementById('joystick-knob');
  const camArea = document.getElementById('camera-area');

  const joyRadius = 48;
  let joyTouchId = null;
  let joyCX = 0, joyCY = 0;

  function updateJoystick(tx, ty) {
    let dx = tx - joyCX, dy = ty - joyCY;
    const dist = Math.hypot(dx, dy);
    if (dist > joyRadius) { dx = dx * joyRadius / dist; dy = dy * joyRadius / dist; }
    joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    joyInput.x = dx / joyRadius;
    joyInput.z = -dy / joyRadius;
  }

  joyBase.addEventListener('touchstart', (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = e.changedTouches[0];
    joyTouchId = t.identifier;
    const r = joyBase.getBoundingClientRect();
    joyCX = r.left + r.width / 2;
    joyCY = r.top + r.height / 2;
    updateJoystick(t.clientX, t.clientY);
  }, { passive: false });

  joyBase.addEventListener('touchmove', (e) => {
    e.preventDefault(); e.stopPropagation();
    for (const t of e.changedTouches) if (t.identifier === joyTouchId) updateJoystick(t.clientX, t.clientY);
  }, { passive: false });

  function joyEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        joyInput.x = 0; joyInput.z = 0;
        joyKnob.style.transform = 'translate(-50%, -50%)';
      }
    }
  }
  joyBase.addEventListener('touchend', joyEnd, { passive: false });
  joyBase.addEventListener('touchcancel', joyEnd, { passive: false });

  // 视角：右半屏滑动
  let camTouchId = null;
  let camLastX = 0, camLastY = 0;
  camArea.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (t.clientX < window.innerWidth * 0.5) return;
    camTouchId = t.identifier;
    camLastX = t.clientX; camLastY = t.clientY;
  }, { passive: false });
  camArea.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== camTouchId) continue;
      const dx = t.clientX - camLastX, dy = t.clientY - camLastY;
      camLastX = t.clientX; camLastY = t.clientY;
      yaw -= dx * 0.008;     // 手指右滑=向右转
      pitch -= dy * 0.008;   // 手指上滑=抬头
      pitch = clamp(pitch, -1.2, 1.2);
    }
  }, { passive: false });
  function camEnd(e) {
    for (const t of e.changedTouches) if (t.identifier === camTouchId) camTouchId = null;
  }
  camArea.addEventListener('touchend', camEnd);
  camArea.addEventListener('touchcancel', camEnd);

  // 射击按钮（按住连发）
  const fireBtn = document.getElementById('btn-fire');
  fireBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fireHeld = true; }, { passive: false });
  fireBtn.addEventListener('touchend', (e) => { e.preventDefault(); fireHeld = false; }, { passive: false });
  fireBtn.addEventListener('touchcancel', () => { fireHeld = false; });

  // 跳跃按钮
  const jumpBtn = document.getElementById('btn-jump');
  jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); doJump(); }, { passive: false });

  // 换枪按钮
  const switchBtn = document.getElementById('btn-switch');
  switchBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); switchWeapon(weaponIndex + 1); }, { passive: false });

  // 换弹按钮
  const reloadBtn = document.getElementById('btn-reload');
  reloadBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); startReload(); }, { passive: false });

  // 开镜按钮（点击开启/关闭，不支持开镜的枪会自动隐藏）
  const adsBtn = document.getElementById('btn-ads');
  adsBtn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); toggleScope(); }, { passive: false });
}

// ---------- 18. 音效（Web Audio 合成，不需要音频文件） ----------
let audioCtx = null;
let noiseBuffer = null;

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    const len = audioCtx.sampleRate * 1;
    noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playShot(type) {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const cfg = {
    smg:    { dur: 0.08, freq: 450, vol: 0.3 },
    rifle:  { dur: 0.12, freq: 650, vol: 0.4 },
    sniper: { dur: 0.35, freq: 250, vol: 0.55 },
  }[type] || { dur: 0.12, freq: 600, vol: 0.4 };

  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(cfg.vol, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + cfg.dur);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cfg.freq * 3, t);
  lp.frequency.exponentialRampToValueAtTime(cfg.freq, t + cfg.dur);
  src.connect(lp).connect(ng).connect(audioCtx.destination);
  src.start(t); src.stop(t + cfg.dur);

  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(cfg.freq, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + cfg.dur);
  const og = audioCtx.createGain();
  og.gain.setValueAtTime(cfg.vol * 0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + cfg.dur);
  osc.connect(og).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + cfg.dur);
}

function playEnemyShot(type) {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const dur = type === 'sniper' ? 0.3 : 0.1;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  src.connect(lp).connect(g).connect(audioCtx.destination);
  src.start(t); src.stop(t + dur);
}

function playJump() {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(600, t + 0.15);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.2);
}

function playReload() {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  for (let i = 0; i < 2; i++) {                       // 两声"咔嗒"模拟换弹
    const osc = audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 380 + i * 260;
    const g = audioCtx.createGain();
    const st = t + i * 0.12;
    g.gain.setValueAtTime(0.14, st);
    g.gain.exponentialRampToValueAtTime(0.001, st + 0.06);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(st); osc.stop(st + 0.07);
  }
}

function playHitConfirm() {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 1200;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.12);
}

function playHurt() {
  ensureAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.15);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.18);
}

// ---------- 19. 主循环 ----------
function animate() {
  requestAnimationFrame(animate);
  if (appState !== 'game' || !sceneReady) return;

  const dt = Math.min(clock.getDelta(), 0.05);

  if (!matchOver) {
    // 开镜减速：高倍镜开镜时移动速度降低
    const curW = currentWeapon();
    const speedMul = (scoped && curW.scope === 'high' && curW.scopedSpeed) ? curW.scopedSpeed : 1;

    if (!iAmEliminated) {
      // 移动输入
      let mx = 0, mz = 0;
      if (keys['KeyW']) mz += 1;
      if (keys['KeyS']) mz -= 1;
      if (keys['KeyA']) mx -= 1;
      if (keys['KeyD']) mx += 1;
      if (Math.abs(joyInput.x) > 0.1 || Math.abs(joyInput.z) > 0.1) {
        mx = joyInput.x; mz = joyInput.z;
      }
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }

      const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
      const rightX = -Math.cos(yaw), rightZ = Math.sin(yaw);   // 屏幕右侧方向（与 lookAt 的右轴一致）
      tryMove((fwdX * mz + rightX * mx) * MOVE_SPEED * speedMul * dt, (fwdZ * mz + rightZ * mx) * MOVE_SPEED * speedMul * dt);
    }

    // 重力 + 贴地（站在起伏地形上）
    const groundY = terrainHeight(playerPos.x, playerPos.z);
    velY += GRAVITY * dt;
    playerPos.y += velY * dt;
    if (playerPos.y <= groundY) {
      playerPos.y = groundY;
      velY = 0;
      grounded = true;
    }

    if (!iAmEliminated) {
      // 射击
      if (fireHeld) {
        if (curW.auto) tryShoot();
        else if (!firePrev) tryShoot();
      }
      firePrev = fireHeld;
    }

    // 换弹冷却结束 → 补满弹匣
    if (reloading && performance.now() >= reloadEndTime) finishReload();
  }

  // 第一人称相机（镜头在眼睛处，朝 yaw/pitch 方向看）
  camera.position.set(playerPos.x, playerPos.y + EYE_HEIGHT, playerPos.z);
  const forward = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  );
  camera.lookAt(camera.position.clone().add(forward));

  // 开镜视野平滑过渡（腰射 ↔ 开镜）
  const targetFov = (scoped && scopeFov) ? scopeFov : BASE_FOV;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
  if (Math.abs(targetFov - camera.fov) < 0.01) camera.fov = targetFov;
  camera.updateProjectionMatrix();

  // 后坐力回位
  recoil = Math.max(0, recoil - dt * 1.6);
  if (fpsGun) {
    fpsGun.position.z = recoil;
    fpsGun.rotation.x = -recoil * 0.6;
  }

  // 枪口火焰衰减
  if (muzzleFlashT > 0) {
    muzzleFlashT -= dt;
    const k = Math.max(0, muzzleFlashT / 0.06);
    muzzleSprite.material.opacity = k;
    muzzleLight.intensity = 5 * k;
    if (muzzleFlashT <= 0) muzzleSprite.visible = false;
  }

  // 更新火花粒子
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    const d = s.userData;
    d.life -= dt;
    if (d.life <= 0) {
      scene.remove(s);
      s.material.dispose();
      sparks.splice(i, 1);
      continue;
    }
    d.vel.y -= 9 * dt;
    s.position.addScaledVector(d.vel, dt);
    s.material.opacity = Math.max(0, d.life / d.maxLife);
    s.scale.setScalar(0.4 + (d.life / d.maxLife) * 0.6);
  }

  // 更新拖尾 / 命中闪光
  for (let i = trails.length - 1; i >= 0; i--) {
    const t = trails[i];
    t.life -= dt;
    if (t.life <= 0) {
      scene.remove(t.obj);
      t.mat.dispose();
      if (t.obj.geometry) t.obj.geometry.dispose();
      trails.splice(i, 1);
      continue;
    }
    t.mat.opacity = t.life / t.maxLife;
  }

  // 远端玩家平滑
  remotePlayers.forEach((rp) => {
    rp.group.position.lerp(rp.targetPos, 0.3);
    rp.group.rotation.y = rp.targetYaw;
  });

  renderer.render(scene, camera);
}

// ---------- 20. 网络 ----------
function setupNetwork() {
  // 大厅信息更新（玩家列表 / 准备状态 / 房主变化）
  socket.on('roomUpdate', (data) => {
    currentRoomId = data.roomId;
    isHost = (data.hostId === myId);
    document.getElementById('lobby-room').textContent = data.roomId;
    const me = data.players.find((p) => p.id === myId);
    if (me) { myReady = me.ready; myTeam = me.team || null; }
    rememberNames(data.players);
    rememberTeams(data.players);
    renderLobby(data.players, data.hostId);
    updateTeamPanel();
  });

  // 房主开始游戏 → 进入对局
  socket.on('gameStart', (data) => {
    const spawn = data.spawns[myId];
    if (!spawn) return;
    if (data.teams) {
      playerTeams.clear();
      Object.entries(data.teams).forEach(([id, t]) => playerTeams.set(id, t || null));
      myTeam = data.teams[myId] || null;
    }
    initScene();
    resetGameState();
    Object.keys(data.spawns).forEach((id) => {
      if (id !== myId) createRemotePlayer(id, data.spawns[id].x, data.spawns[id].z, data.spawns[id].yaw);
    });
    startFps(spawn);
    appState = 'game';
    showScreen('game');
    document.getElementById('result-overlay').style.display = 'none';
    updateHud();
    updateWeaponLabel();
    updateAmmoLabel();
    buildEnemyHud(Object.keys(data.spawns).filter((id) => id !== myId));
    updateHpBars();
    updateLivesUI();
    updateAdsButton();
  });

  socket.on('playerMove', (data) => {
    const rp = remotePlayers.get(data.id);
    if (rp) {
      rp.targetPos.set(data.position.x, data.position.y, data.position.z);
      rp.targetYaw = data.rotation;
    }
  });

  socket.on('playerLeft', (data) => {
    removeRemotePlayer(data.id);
    enemyHp.delete(data.id);
    enemyLives.delete(data.id);
    removeEnemyHpBar(data.id);
    if (appState === 'game' && !matchOver) {
      showResult('有玩家离开了');
      setTimeout(goToLobby, 1500);
    }
    updateHud();
  });

  socket.on('healthUpdate', (data) => {
    if (data.id === myId) {
      myHp = data.hp;
      if (data.damage > 0) playHurt();
    } else {
      enemyHp.set(data.id, data.hp);
    }
    updateHpBars();
  });

  // 有人复活（第一条命被打空）
  socket.on('respawn', (data) => {
    if (data.id === myId) {
      // 我复活：回到新出生点，满血，补满弹匣
      playerPos.set(data.position.x, terrainHeight(data.position.x, data.position.z), data.position.z);
      yaw = data.rotation;
      pitch = 0;
      velY = 0; grounded = true;
      myHp = data.hp;
      myLives = data.lives;
      ammo = WEAPON_ORDER.map((id) => WEAPONS[id].magazine);
      reserveAmmo = WEAPON_ORDER.map((id) => WEAPONS[id].reserve);
      reloading = false;
      scoped = false; scopeFov = null;
      updateScopeOverlay();
      showHitIndicator('复活！还剩 ' + myLives + ' 条命');
    } else {
      const rp = remotePlayers.get(data.id);
      if (rp) {
        rp.targetPos.set(data.position.x, terrainHeight(data.position.x, data.position.z), data.position.z);
        rp.targetYaw = data.rotation;
      }
      enemyHp.set(data.id, data.hp);
      enemyLives.set(data.id, data.lives);
    }
    updateHpBars();
    updateLivesUI();
  });

  // 有人被淘汰（两条命耗尽）
  socket.on('eliminated', (data) => {
    if (data.id === myId) {
      iAmEliminated = true;
      myLives = 0;
      fireHeld = false;
      scoped = false; scopeFov = null;
      updateScopeOverlay();
      showResult('💀 你已淘汰', '观战中，等待本局结束…');
      setTimeout(() => {
        if (appState === 'game' && !matchOver) document.getElementById('result-overlay').style.display = 'none';
      }, 2000);
    } else {
      enemyLives.set(data.id, 0);
      enemyHp.delete(data.id);
      removeRemotePlayer(data.id);
      removeEnemyHpBar(data.id);
    }
    updateHpBars();
    updateLivesUI();
    updateHud();
  });

  socket.on('matchEnd', (data) => {
    matchOver = true;
    iAmEliminated = false;
    fireHeld = false;
    scoped = false; scopeFov = null;
    updateScopeOverlay();
    let won = false;
    if (data.winnerTeam) won = (myTeam === data.winnerTeam);
    else if (data.winnerId) won = (data.winnerId === myId);
    showResult(won ? '🎉 胜利！' : '💀 失败…');
    setTimeout(goToLobby, 3000);
  });

  socket.on('shotFired', (data) => {
    playEnemyShot(data.weapon);
  });

  // 每 50ms 上报一次位置
  setInterval(() => {
    if (appState !== 'game' || !sceneReady || iAmEliminated) return;
    socket.emit('move', {
      position: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      rotation: yaw,
    });
  }, 50);
}

// ---------- 21. 界面 ----------
function showScreen(name) {
  document.getElementById('menu').style.display = (name === 'menu') ? 'flex' : 'none';
  document.getElementById('lobby').style.display = (name === 'lobby') ? 'flex' : 'none';
  document.getElementById('game').style.display = (name === 'game') ? 'block' : 'none';
}

// 渲染大厅玩家列表 + 准备/开始按钮状态
function renderLobby(players, hostId) {
  document.getElementById('lobby-count').textContent = '当前人数：' + players.length + ' / 4';
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'player-item';
    const hostTag = (p.id === hostId) ? '<span class="badge">房主</span>' : '';
    const readyTag = p.ready ? '<span class="ready">已准备</span>' : '<span class="notready">未准备</span>';
    const you = (p.id === myId) ? '（我）' : '';
    const teamDot = '<span class="team-dot" style="background:' + teamCss(p.team) + '" title="' + teamName(p.team) + '"></span>';
    div.innerHTML = '<span class="pname">' + esc(p.name) + you + teamDot + ' ' + hostTag + '</span>' + readyTag;
    list.appendChild(div);
  });

  const btnStart = document.getElementById('btn-start');
  btnStart.style.display = (myId === hostId) ? 'block' : 'none';
  const canStart = (myId === hostId) && players.length >= 2 && players.every((p) => p.ready);
  btnStart.disabled = !canStart;

  const me = players.find((p) => p.id === myId);
  document.getElementById('btn-ready').textContent = (me && me.ready) ? '取消准备' : '准备';

  const msg = document.getElementById('lobby-msg');
  if (myId !== hostId) {
    msg.textContent = (me && me.ready) ? '已准备，等待房主开始…' : '点「准备」后等待房主开始';
  } else if (players.length < 2) {
    msg.textContent = '等待更多玩家加入…（2-4 人可开始，把房间号告诉朋友）';
  } else if (!players.every((p) => p.ready)) {
    msg.textContent = '等待所有玩家准备…';
  } else {
    msg.textContent = '都准备好了，点「开始游戏」！';
  }
}

function updateHud() {
  document.getElementById('room-label').textContent = '房间号：' + currentRoomId;
  const count = 1 + remotePlayers.size;
  document.getElementById('player-count').textContent = '人数：' + count + ' / 4';
}
function updateWeaponLabel() {
  const w = currentWeapon();
  document.getElementById('weapon-label').textContent = '武器：' + w.name;
  document.getElementById('btn-switch').textContent = w.name;
}
function updateAmmoLabel() {
  const el = document.getElementById('ammo-label');
  if (!el) return;
  const w = currentWeapon();
  if (reloading) {
    el.textContent = '换弹中…';
    el.style.color = '#ffd23f';
  } else {
    el.textContent = ammo[weaponIndex] + ' / ' + w.magazine + '  |  备弹 ' + reserveAmmo[weaponIndex];
    if (ammo[weaponIndex] <= 0) el.style.color = '#ff4a4a';
    else if (ammo[weaponIndex] <= w.magazine * 0.3) el.style.color = '#ffb340';
    else el.style.color = '#fff';
  }
}
function updateHpBars() {
  const myBar = document.getElementById('hp-my');
  myBar.style.width = (myHp / MAX_HP * 100) + '%';
  myBar.style.background = hpColor(myHp);
  enemyHp.forEach((hp, id) => {
    const bar = document.getElementById('hp-enemy-' + id);
    if (bar) {
      bar.style.width = (hp / MAX_HP * 100) + '%';
      bar.style.background = hpColor(hp);
    }
  });
}
function hpColor(hp) {
  if (hp > MAX_HP * 0.5) return '#4cd964';
  if (hp > MAX_HP * 0.25) return '#ffb340';
  return '#ff4a4a';
}

// 显示我自己 + 每个对手的剩余生命条数
function updateLivesUI() {
  const el = document.getElementById('lives-label');
  if (el) el.textContent = '生命：' + '❤'.repeat(Math.max(0, myLives));
  enemyLives.forEach((lives, id) => {
    const l = document.getElementById('lives-enemy-' + id);
    if (l) l.textContent = '❤'.repeat(Math.max(0, lives));
  });
}

// 记录玩家昵称（大厅收到列表时调用）
function rememberNames(players) {
  playerNames.clear();
  players.forEach((p) => playerNames.set(p.id, p.name));
}

// 为每个对手生成一条血条
function buildEnemyHud(ids) {
  const container = document.getElementById('enemy-hp-container');
  container.innerHTML = '';
  enemyHp.clear();
  enemyLives.clear();
  ids.forEach((id, i) => {
    enemyHp.set(id, MAX_HP);
    enemyLives.set(id, 2);
    const row = document.createElement('div');
    row.className = 'hp-row';
    row.innerHTML = '<span class="hp-name">' + esc(playerNames.get(id) || ('对手' + (i + 1))) + '</span>'
      + '<span class="lives" id="lives-enemy-' + id + '">❤❤</span>'
      + '<div class="hp-bar"><div id="hp-enemy-' + id + '"></div></div>';
    container.appendChild(row);
  });
}

function removeEnemyHpBar(id) {
  const bar = document.getElementById('hp-enemy-' + id);
  if (bar) {
    const row = bar.closest('.hp-row');
    if (row) row.remove();
  }
}

let hitTimer = null;
function showHitIndicator(text) {
  const el = document.getElementById('hit-indicator');
  el.textContent = text;
  el.style.opacity = '1';
  if (hitTimer) clearTimeout(hitTimer);
  hitTimer = setTimeout(() => { el.style.opacity = '0'; }, 350);
}
function showResult(text, sub) {
  document.getElementById('result-text').textContent = text;
  const subEl = document.querySelector('#result-overlay .sub');
  if (subEl) subEl.textContent = sub || '即将返回房间…';
  document.getElementById('result-overlay').style.display = 'flex';
}
function showMessage(msg) {
  document.getElementById('menu-msg').textContent = msg;
}
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

// 进入大厅
function enterLobby(data) {
  myId = data.youId;
  currentRoomId = data.roomId;
  isHost = (data.hostId === myId);
  myReady = false;
  appState = 'lobby';
  document.getElementById('lobby-room').textContent = data.roomId;
  const me = data.players.find((p) => p.id === myId);
  myTeam = me ? (me.team || null) : null;
  rememberNames(data.players);
  rememberTeams(data.players);
  renderLobby(data.players, data.hostId);
  updateTeamPanel();
  showScreen('lobby');
  showMessage('');
}

// 从对局返回大厅（结算后 / 对手离开）
function goToLobby() {
  matchOver = false;
  appState = 'lobby';
  fireHeld = false;
  if (document.pointerLockElement) document.exitPointerLock();
  document.getElementById('result-overlay').style.display = 'none';
  showScreen('lobby');
  resetGameState();
}

// 离开房间回主菜单
function leaveLobby() {
  socket.emit('leaveRoom');
  appState = 'menu';
  myId = null; currentRoomId = null; isHost = false; myReady = false;
  showScreen('menu');
}

// ---------- 22. （横屏锁定相关逻辑已移除，改为竖屏使用） ----------

// ---------- 23. 通用"点一下"绑定 ----------
// 手机用 touchstart，电脑用 click；时间戳防止手机一次触摸同时触发两次。
function bindTap(el, handler) {
  let lastTouch = 0;
  el.addEventListener('touchstart', (e) => {
    lastTouch = Date.now();
    e.preventDefault();
    handler();
  }, { passive: false });
  el.addEventListener('click', () => {
    if (Date.now() - lastTouch < 700) return;
    handler();
  });
}

// ---------- 24. 页面启动 ----------
function initMenu() {
  const url = location.origin + location.pathname;
  new QRCode(document.getElementById('qrcode'), {
    text: url, width: 150, height: 150,
    colorDark: '#000000', colorLight: '#ffffff',
  });

  // 防止手机输入法在房间号里自动带入空格/换行：输入时只保留字母数字
  sanitizeRoomInput(document.getElementById('custom-room'));
  sanitizeRoomInput(document.getElementById('room-input'));

  // 创建房间（自动生成房间号，或填入"自定义房间号"手动指定）
  bindTap(document.getElementById('btn-create'), () => {
    const name = document.getElementById('name-input').value.trim() || '玩家';
    const custom = document.getElementById('custom-room').value.trim().toUpperCase();
    socket.emit('createRoom', { name, roomId: custom }, (res) => {
      if (res.success) enterLobby(res);
      else showToast(res.message || '创建失败');
    });
  });

  // 加入房间：touchend（手机触摸）+ click（电脑鼠标）双兼容
  bindJoinButton();
}

// 输入时实时过滤：房间号只允许字母和数字，去掉空格/换行
function sanitizeRoomInput(el) {
  el.addEventListener('input', () => {
    const cleaned = el.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (cleaned !== el.value) el.value = cleaned;
  });
}

// 加入房间按钮：手机触摸用 touchend 更可靠，避免被输入法/聚焦打断
function bindJoinButton() {
  const btn = document.getElementById('btn-join');
  let lastTouch = 0;
  const doJoin = () => {
    const name = document.getElementById('name-input').value.trim() || '玩家';
    // 关键：trim() 去首尾空格，再 replace 去掉中间可能混入的空格/换行
    const code = document.getElementById('room-input').value.trim().replace(/\s+/g, '').toUpperCase();
    console.log('[加入房间] 读取到的房间号 =', JSON.stringify(code), '| 昵称 =', JSON.stringify(name));
    if (!code) { showMessage('请输入房间号'); return; }
    socket.emit('joinRoom', { roomId: code, name }, (res) => {
      if (res.success) enterLobby(res);
      else showToast(res.message || '加入失败');
    });
  };
  btn.addEventListener('touchend', (e) => {
    lastTouch = Date.now();
    e.preventDefault();
    doJoin();
  }, { passive: false });
  btn.addEventListener('click', () => {
    if (Date.now() - lastTouch < 700) return;
    doJoin();
  });
}

function initLobby() {
  bindTap(document.getElementById('btn-ready'), () => {
    myReady = !myReady;
    socket.emit('setReady', { ready: myReady });
  });
  bindTap(document.getElementById('btn-start'), () => {
    socket.emit('startGame');
  });
  bindTap(document.getElementById('btn-leave'), () => {
    leaveLobby();
  });
  bindTap(document.getElementById('team-red'), () => socket.emit('setTeam', { team: 'red' }));
  bindTap(document.getElementById('team-blue'), () => socket.emit('setTeam', { team: 'blue' }));
  bindTap(document.getElementById('team-ffa'), () => socket.emit('setTeam', { team: null }));
}

// 高亮当前所选队伍按钮
function updateTeamPanel() {
  ['team-red', 'team-blue', 'team-ffa'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active');
  });
  const map = { red: 'team-red', blue: 'team-blue' };
  const activeId = myTeam ? map[myTeam] : 'team-ffa';
  const active = document.getElementById(activeId);
  if (active) active.classList.add('active');
}

// 首次交互：预热音频（浏览器要求用户先点击才允许出声）
document.addEventListener('pointerdown', () => ensureAudio(), { once: true });

window.addEventListener('resize', onResize);

if ('ontouchstart' in window) document.body.classList.add('touch');

initMenu();
initLobby();
setupNetwork();
animate();
