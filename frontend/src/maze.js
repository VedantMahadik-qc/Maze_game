// Classical maze generator standing in for Labyrinth (step 2 of the build
// order -- no Atlas calls yet). This is exactly the piece that gets swapped
// for a real labyrinth-v1 call in step 3: same output shape (a wall list +
// room lookup), different source of truth (recursive backtracker here,
// `target.edge_signs` -- corridor vs wall per coupling_map edge -- there).

export const CELL_SIZE = 4; // world units per grid cell
export const WALL_HEIGHT = 3;
export const WALL_THICKNESS = 0.2;

// 2x2 cell blocks; each becomes one fully-open room once maze generation
// finishes. Corners chosen so the recursive backtracker's spanning tree
// (which touches every cell) is guaranteed to already reach each block from
// at least one side.
const ROOM_BLOCKS = [
  { x: 0, y: 0, kind: "start" },
  { x: 4, y: 1, kind: "hide" },
  { x: 1, y: 5, kind: "hide" },
  { x: 7, y: 6, kind: "hide" },
  { x: 8, y: 8, kind: "exit" },
];

export function generateHouse({ width = 10, height = 10, seed } = {}) {
  const rand = mulberry32(seed ?? (Date.now() >>> 0));

  // cells[y][x] = { walls: {N,E,S,W}: bool present, visited: bool }
  const cells = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      row.push({ N: true, E: true, S: true, W: true, visited: false, room: null });
    }
    cells.push(row);
  }

  carveRecursiveBacktracker(cells, width, height, rand);

  const rooms = ROOM_BLOCKS.map((block, i) => placeRoom(cells, width, height, block, i));

  return {
    width,
    height,
    cells,
    rooms,
    startRoom: rooms.find((r) => r.kind === "start"),
    exitRoom: rooms.find((r) => r.kind === "exit"),
    toWorld: (cx, cy) => ({ x: (cx + 0.5) * CELL_SIZE, z: (cy + 0.5) * CELL_SIZE }),
    cellAtWorld: (wx, wz) => ({
      x: Math.floor(wx / CELL_SIZE),
      y: Math.floor(wz / CELL_SIZE),
    }),
    roomAt(cx, cy) {
      if (cx < 0 || cy < 0 || cy >= height || cx >= width) return null;
      return cells[cy][cx].room;
    },
  };
}

function carveRecursiveBacktracker(cells, width, height, rand) {
  const stack = [];
  const start = { x: (rand() * width) | 0, y: (rand() * height) | 0 };
  cells[start.y][start.x].visited = true;
  stack.push(start);

  const dirs = [
    { dx: 0, dy: -1, from: "N", to: "S" },
    { dx: 1, dy: 0, from: "E", to: "W" },
    { dx: 0, dy: 1, from: "S", to: "N" },
    { dx: -1, dy: 0, from: "W", to: "E" },
  ];

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const candidates = [];
    for (const d of dirs) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!cells[ny][nx].visited) candidates.push({ nx, ny, d });
    }
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    const { nx, ny, d } = candidates[(rand() * candidates.length) | 0];
    cells[cur.y][cur.x][d.from] = false;
    cells[ny][nx][d.to] = false;
    cells[ny][nx].visited = true;
    stack.push({ x: nx, y: ny });
  }
}

function placeRoom(cells, width, height, block, index) {
  const { x, y, kind } = block;
  const roomCells = [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ].filter(([cx, cy]) => cx < width && cy < height);

  const room = { id: index, kind, cells: roomCells, cx: x, cy: y };

  // Open every internal wall between the block's cells -- doorways to the
  // surrounding maze are whatever the spanning tree already carved on the
  // block's outer boundary, so connectivity is never broken by this step.
  const has = (cx, cy) => roomCells.some(([rx, ry]) => rx === cx && ry === cy);
  for (const [cx, cy] of roomCells) {
    const cell = cells[cy][cx];
    cell.room = room;
    if (has(cx, cy - 1)) cell.N = false;
    if (has(cx + 1, cy)) cell.E = false;
    if (has(cx, cy + 1)) cell.S = false;
    if (has(cx - 1, cy)) cell.W = false;
  }
  return room;
}

// Deterministic PRNG so a house is reproducible from its seed (handy for
// debugging a specific layout without regenerating a new one each reload).
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wall segments as world-space AABBs, for both rendering and collision.
export function buildWallSegments(house) {
  const { cells, width, height } = house;
  const segments = [];
  const t = WALL_THICKNESS / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y][x];
      const wx = x * CELL_SIZE;
      const wz = y * CELL_SIZE;
      if (cell.N) segments.push(wallAABB(wx, wz, wx + CELL_SIZE, wz, t));
      if (cell.W) segments.push(wallAABB(wx, wz, wx, wz + CELL_SIZE, t));
      // Only emit S/E on the outer boundary -- interior S/E walls are the
      // neighbor cell's N/W and would otherwise be doubled up.
      if (cell.S && y === height - 1) segments.push(wallAABB(wx, wz + CELL_SIZE, wx + CELL_SIZE, wz + CELL_SIZE, t));
      if (cell.E && x === width - 1) segments.push(wallAABB(wx + CELL_SIZE, wz, wx + CELL_SIZE, wz + CELL_SIZE, t));
    }
  }
  return segments;
}

const DIRS = [
  { dx: 0, dy: -1, wall: "N" },
  { dx: 1, dy: 0, wall: "E" },
  { dx: 0, dy: 1, wall: "S" },
  { dx: -1, dy: 0, wall: "W" },
];

// Every open connection between a room cell and a non-room (corridor) cell
// -- i.e. every real doorway a player actually walks through. Purely for
// dressing the gap with a door mesh; collision is unaffected.
export function getRoomDoorways(house) {
  const { cells, width, height, rooms } = house;
  const doorways = [];
  for (const room of rooms) {
    for (const [cx, cy] of room.cells) {
      const cell = cells[cy][cx];
      for (const d of DIRS) {
        if (cell[d.wall]) continue;
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (cells[ny][nx].room) continue; // room-to-room, not a real doorway
        doorways.push(doorwayTransform(cx, cy, d));
      }
    }
  }
  return doorways;
}

// The one doorway that matters for winning: a wall on the exit room's block
// that sits on the house's actual outer boundary, not an internal doorway.
// The exit room is placed at a grid corner specifically so this always
// exists -- carving never touches outer-boundary walls (see
// carveRecursiveBacktracker's bounds check), so it's guaranteed present.
export function getExitDoor(house) {
  const { cells, width, height, exitRoom } = house;
  for (const [cx, cy] of exitRoom.cells) {
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      const isOuterBoundary = nx < 0 || ny < 0 || nx >= width || ny >= height;
      if (isOuterBoundary && cells[cy][cx][d.wall]) {
        return doorwayTransform(cx, cy, d);
      }
    }
  }
  return null;
}

// World-space placement + orientation for a doorway on cell (cx,cy)'s `d`
// side: position is the midpoint of that wall segment, `facingNS` says
// whether the wall itself runs east-west (true, an N/S-side wall -- frame
// spans local X) or north-south (false, an E/W-side wall -- frame spans
// local Z, so the door group needs a 90 degree yaw to match).
function doorwayTransform(cx, cy, d) {
  const cellCenter = { x: (cx + 0.5) * CELL_SIZE, z: (cy + 0.5) * CELL_SIZE };
  return {
    x: cellCenter.x + (d.dx * CELL_SIZE) / 2,
    z: cellCenter.z + (d.dy * CELL_SIZE) / 2,
    facingNS: d.dx === 0,
    // Points from the wall out into whichever side `d` faces -- used to
    // offset a trigger/marker a little into the room off the wall plane.
    normalX: d.dx,
    normalZ: d.dy,
  };
}

function wallAABB(x1, z1, x2, z2, t) {
  return {
    minX: Math.min(x1, x2) - t,
    maxX: Math.max(x1, x2) + t,
    minZ: Math.min(z1, z2) - t,
    maxZ: Math.max(z1, z2) + t,
    horizontal: z1 === z2,
  };
}
