import type { Vector3 } from "@minecraft/server";
import { MinecraftBlockTypes, MinecraftItemTypes } from "@minecraft/vanilla-data";

/**
 * Turns an ordered list of field markers into a complete build plan.
 * Pure logic (no world access), so it can be unit tested outside the game.
 *
 * Heights: L = field level (the ground the markers stand on).
 *   L     dirt / farmland / water, the bone meal hopper and chest of the compost station
 *   L + 1 crops, fences, gate, chests, bed, composter, compost hopper, lamp posts, markers
 *   L + 2 torches, compost chest
 *   L + 3 kept free (cleared)
 */

export const FIELD_MARKER = "mob:field_marker";

/**
 * Bed `direction` state -> offset from the foot to the head piece.
 * NOTE: mapping (0 = south, 1 = west, 2 = north, 3 = east) follows the legacy Bedrock direction convention
 * and still has to be verified in game.
 */
export const BED_DIRECTIONS: readonly { direction: number; toHead: Cell }[] = [
  { direction: 0, toHead: { x: 0, z: 1 } },
  { direction: 1, toHead: { x: -1, z: 0 } },
  { direction: 2, toHead: { x: 0, z: -1 } },
  { direction: 3, toHead: { x: 1, z: 0 } },
];

export interface Cell {
  readonly x: number;
  readonly z: number;
}

/** The chests the farmer manages. Crop chests are only placed once that crop is harvested. */
export type ChestRole = "input" | "leftovers" | "seeds" | "compost" | "bone_meal" | `crop:${string}`;

/** Crop block -> seed item and harvested vegetable. */
export const CROPS: readonly { block: string; seed: string; produce: string }[] = [
  { block: MinecraftBlockTypes.Wheat, seed: MinecraftItemTypes.WheatSeeds, produce: MinecraftItemTypes.Wheat },
  { block: MinecraftBlockTypes.Carrots, seed: MinecraftItemTypes.Carrot, produce: MinecraftItemTypes.Carrot },
  { block: MinecraftBlockTypes.Potatoes, seed: MinecraftItemTypes.Potato, produce: MinecraftItemTypes.Potato },
  { block: MinecraftBlockTypes.Beetroot, seed: MinecraftItemTypes.BeetrootSeeds, produce: MinecraftItemTypes.Beetroot },
];
const CROP_BLOCKS = new Set(CROPS.map((c) => c.block));
const SEED_ITEMS = CROPS.map((c) => c.seed);

export const WOODEN_FENCES: readonly string[] = [
  "oak",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "dark_oak",
  "mangrove",
  "cherry",
  "pale_oak",
  "bamboo",
  "crimson",
  "warped",
].map((wood) => `minecraft:${wood}_fence`);

export const FENCE_GATES: readonly string[] = [
  MinecraftBlockTypes.FenceGate, // oak
  ...WOODEN_FENCES.filter((f) => f !== "minecraft:oak_fence").map((f) => `${f}_gate`),
];

/** One block the farmer places, possibly with block states. */
export interface Placement {
  readonly location: Vector3;
  readonly block: string;
  readonly states?: Record<string, string | number | boolean>;
}

export interface Material {
  /** Any of these items can be used. */
  readonly items: readonly string[];
  /** Container the farmer takes the item from. */
  readonly source: "input" | "seeds";
  /** Item that is put back into the input chest after use (empty bucket). */
  readonly returns?: string;
  /** Human readable name for status messages. */
  readonly label: string;
}

export interface BuildStep {
  readonly location: Vector3;
  /** The step is done when the block here passes this test. */
  readonly done: (typeId: string) => boolean;
  /** Blocks that may stay in place and still need work (e.g. dirt that gets tilled). Everything else is cleared first. */
  readonly keep?: (typeId: string) => boolean;
  /** Skips the step entirely (e.g. planting where there is no farmland). */
  readonly skipIf?: { readonly below: (typeId: string) => boolean };
  /** Undefined for a pure clearing step. */
  readonly place?: (item: string | undefined) => Placement[];
  /** Undefined = free (no item needed). */
  readonly material?: Material;
  /** Placed blocks that need free space (no entity standing there). */
  readonly solid?: boolean;
}

export interface FieldPlan {
  readonly level: number;
  readonly boundary: readonly Cell[];
  readonly interior: readonly Cell[];
  readonly farmland: readonly Vector3[];
  readonly chests: Readonly<Record<ChestRole, Vector3>>;
  readonly bed: { readonly head: Vector3; readonly foot: Vector3 };
  readonly steps: readonly BuildStep[];
}

export type PlanResult = { plan: FieldPlan } | { error: string };

const key = (c: Cell): string => `${c.x},${c.z}`;
const add = (c: Cell, d: Cell, n = 1): Cell => ({ x: c.x + d.x * n, z: c.z + d.z * n });
const at = (c: Cell, y: number): Vector3 => ({ x: c.x, y, z: c.z });
const DIRS: readonly Cell[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];
const DIR_NAMES: Record<string, string> = { "1,0": "east", "-1,0": "west", "0,1": "south", "0,-1": "north" };

/** Hopper `facing_direction`: 2 = north/-z, 3 = south/+z, 4 = west/-x, 5 = east/+x. */
const hopperFacing = (d: Cell): number => (d.x > 0 ? 5 : d.x < 0 ? 4 : d.z > 0 ? 3 : 2);

/** 4-connected line between two cells, so that the fence has no diagonal gaps. */
export function rasterize(a: Cell, b: Cell): Cell[] {
  const dx = Math.abs(b.x - a.x);
  const dz = Math.abs(b.z - a.z);
  const sx = Math.sign(b.x - a.x);
  const sz = Math.sign(b.z - a.z);
  let { x, z } = a;
  let err = dx - dz;
  const out: Cell[] = [{ x, z }];
  while (x !== b.x || z !== b.z) {
    const stepX = z === b.z || (x !== b.x && 2 * err > -dz);
    if (stepX) {
      err -= dz;
      x += sx;
    } else {
      err += dx;
      z += sz;
    }
    out.push({ x, z });
  }
  return out;
}

/** Even-odd test of a cell centre against the polygon through the marker centres. */
function inside(c: Cell, poly: readonly Cell[]): boolean {
  const px = c.x + 0.5;
  const pz = c.z + 0.5;
  let result = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi, xj, zj] = [poly[i].x + 0.5, poly[i].z + 0.5, poly[j].x + 0.5, poly[j].z + 0.5];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) result = !result;
  }
  return result;
}

export function planField(markers: readonly Vector3[]): PlanResult {
  if (markers.length < 3) return { error: "needs at least 3 field markers" };
  const level = Math.round(markers.reduce((s, m) => s + m.y, 0) / markers.length) - 1;
  const poly: Cell[] = markers.map((m) => ({ x: m.x, z: m.z }));
  const markerKeys = new Set(poly.map(key));

  // --- outline and inside ---------------------------------------------------------------------
  const boundary: Cell[] = [];
  const boundaryKeys = new Set<string>();
  poly.forEach((m, i) => {
    for (const c of rasterize(m, poly[(i + 1) % poly.length])) {
      if (!boundaryKeys.has(key(c))) {
        boundaryKeys.add(key(c));
        boundary.push(c);
      }
    }
  });

  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const interior: Cell[] = [];
  const interiorKeys = new Set<string>();
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const c = { x, z };
      if (!boundaryKeys.has(key(c)) && inside(c, poly)) {
        interior.push(c);
        interiorKeys.add(key(c));
      }
    }
  }
  if (interior.length < 20) return { error: "field is too small (needs at least 20 blocks inside the markers)" };

  // --- gate: a straight piece of fence with the field on one side --------------------------------
  const isB = (c: Cell) => boundaryKeys.has(key(c));
  const isI = (c: Cell) => interiorKeys.has(key(c));
  const firstEdgeMid = { x: (poly[0].x + poly[1].x) / 2, z: (poly[0].z + poly[1].z) / 2 };
  let gate: { cell: Cell; inside: Cell; direction: string } | undefined;
  let gateDistance = Infinity;
  for (const c of boundary) {
    if (markerKeys.has(key(c))) continue;
    const alongX = isB(add(c, DIRS[0])) && isB(add(c, DIRS[1])) && !isB(add(c, DIRS[2])) && !isB(add(c, DIRS[3]));
    const alongZ = isB(add(c, DIRS[2])) && isB(add(c, DIRS[3])) && !isB(add(c, DIRS[0])) && !isB(add(c, DIRS[1]));
    const inner = alongX ? [DIRS[2], DIRS[3]] : alongZ ? [DIRS[0], DIRS[1]] : [];
    const innerCell = inner.map((d) => add(c, d)).find(isI);
    if (!innerCell) continue;
    const distance = Math.hypot(c.x - firstEdgeMid.x, c.z - firstEdgeMid.z);
    if (distance < gateDistance) {
      gateDistance = distance;
      // A gate facing south/north spans a fence running east-west.
      gate = { cell: c, inside: innerCell, direction: alongX ? "south" : "east" };
    }
  }
  if (!gate) return { error: "found no straight piece of fence for the gate" };

  // --- facilities, placed close to the gate --------------------------------------------------------
  const order: Cell[] = [];
  const seen = new Set([key(gate.inside)]);
  for (let queue = [gate.inside]; queue.length > 0;) {
    const c = queue.shift()!;
    order.push(c);
    for (const d of DIRS) {
      const n = add(c, d);
      if (isI(n) && !seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
    }
  }

  const used = new Set([key(gate.inside)]); // keep the entrance free
  const chestCells = new Set<string>();
  const free = (c: Cell) => isI(c) && !used.has(key(c));
  const touchesChest = (c: Cell) => DIRS.some((d) => chestCells.has(key(add(c, d))));

  const placeChest = (): Cell | undefined => {
    const c = order.find((o) => free(o) && !touchesChest(o));
    if (c) {
      used.add(key(c));
      chestCells.add(key(c));
    }
    return c;
  };
  const placeLine = (length: number): { cells: Cell[]; dir: Cell } | undefined => {
    for (const c of order) {
      for (const dir of DIRS) {
        const cells = Array.from({ length }, (_, i) => add(c, dir, i));
        // Do not block the free cells around normal chests either, so they stay openable from the side.
        if (cells.every((x) => free(x) && !chestCells.has(key(x)))) {
          cells.forEach((x) => used.add(key(x)));
          return { cells, dir };
        }
      }
    }
    return undefined;
  };

  const L = level;
  const chestRoles: ChestRole[] = ["input", "leftovers", "seeds", ...CROPS.map((c) => `crop:${c.produce}` as const)];
  const chests = {} as Record<ChestRole, Vector3>;
  for (const role of chestRoles) {
    const c = placeChest();
    if (!c) return { error: "field is too small for all chests" };
    chests[role] = at(c, L + 1);
  }
  const compost = placeLine(3);
  if (!compost) return { error: "field is too small for the compost station" };
  const [hopperCell, composterCell, boneMealCell] = compost.cells;
  chests.compost = at(hopperCell, L + 2);
  chests.bone_meal = at(boneMealCell, L);
  const bedLine = placeLine(2);
  if (!bedLine) return { error: "field is too small for the bed" };
  const bedDirection = BED_DIRECTIONS.find((d) => d.toHead.x === bedLine.dir.x && d.toHead.z === bedLine.dir.z)!;
  const bed = { foot: at(bedLine.cells[0], L + 1), head: at(bedLine.cells[1], L + 1) };

  // --- water every 9x9 blocks (farmland needs water within 4), then fill any gaps -----------------
  const water: Cell[] = interior.filter((c) => free(c) && (c.x - minX) % 9 === 4 && (c.z - minZ) % 9 === 4);
  water.forEach((c) => used.add(key(c)));
  const watered = (c: Cell) => water.some((w) => Math.abs(w.x - c.x) <= 4 && Math.abs(w.z - c.z) <= 4);
  for (const c of interior) {
    if (free(c) && !watered(c)) {
      water.push(c);
      used.add(key(c));
    }
  }
  // A lamp post (fence + torch) next to every water spot.
  const lampPosts: Cell[] = [];
  for (const w of water) {
    const post = DIRS.map((d) => add(w, d)).find(free);
    if (post) {
      used.add(key(post));
      lampPosts.push(post);
    }
  }
  const farmlandCells = interior.filter(free);

  // --- what goes where ------------------------------------------------------------------------------
  const is =
    (...ids: readonly string[]) =>
    (t: string) =>
      ids.includes(t);
  const AIR = MinecraftBlockTypes.Air;
  const isCrop = (t: string) => CROP_BLOCKS.has(t);
  const dirtLike = is(MinecraftBlockTypes.Dirt, MinecraftBlockTypes.GrassBlock, MinecraftBlockTypes.Farmland);
  const solidGround = (t: string) =>
    t !== AIR &&
    t !== MinecraftBlockTypes.Water &&
    t !== MinecraftBlockTypes.Lava &&
    t !== MinecraftBlockTypes.FlowingWater;

  const chestItem: Material = { items: [MinecraftItemTypes.Chest], source: "input", label: "Chest" };
  const dirt: Material = { items: [MinecraftItemTypes.Dirt], source: "input", label: "Dirt" };
  const fence: Material = { items: WOODEN_FENCES, source: "input", label: "Wooden Fence" };
  const torch: Material = { items: [MinecraftItemTypes.Torch], source: "input", label: "Torch" };
  const one = (location: Vector3, block: string, states?: Placement["states"]): Placement[] => [
    { location, block, states },
  ];
  const fenceAt = new Set([...boundary.filter((c) => !markerKeys.has(key(c))).map(key), ...lampPosts.map(key)]);
  const connections = (c: Cell): Placement["states"] =>
    Object.fromEntries(
      DIRS.map((d) => {
        const n = add(c, d);
        const connected = fenceAt.has(key(n)) || markerKeys.has(key(n)) || key(n) === key(gate!.cell);
        return [`minecraft:connection_${DIR_NAMES[`${d.x},${d.z}`]}`, connected];
      })
    );

  /** Positions that get a block; everything else in the area is cleared up to L + 3. */
  const planned = new Map<string, BuildStep>();
  const steps: BuildStep[] = [];
  const plan3 = (s: BuildStep) => planned.set(`${s.location.x},${s.location.y},${s.location.z}`, s);

  const chestStep = (location: Vector3, material: Material | undefined): BuildStep => ({
    location,
    done: is(MinecraftBlockTypes.Chest),
    place: () => one(location, MinecraftBlockTypes.Chest),
    material,
    solid: true,
  });

  // 1. the input chest (free, so that materials can be delivered) and the leftovers chest
  const inputStep = chestStep(chests.input, undefined);
  const leftoversStep = chestStep(chests.leftovers, chestItem);

  // 2. ground level
  const groundSteps: BuildStep[] = [];
  for (const c of boundary) {
    groundSteps.push({ location: at(c, L), done: solidGround, place: (i) => one(at(c, L), i!), material: dirt });
  }
  const specialGround = new Set([key(composterCell), key(boneMealCell), ...water.map(key)]);
  for (const c of interior.filter((c) => !specialGround.has(key(c)))) {
    groundSteps.push({ location: at(c, L), done: dirtLike, place: (i) => one(at(c, L), i!), material: dirt });
  }

  // 3. fence, gate and torches on the fence
  const fenceSteps: BuildStep[] = [];
  const torchSteps: BuildStep[] = [];
  boundary.forEach((c, index) => {
    if (markerKeys.has(key(c))) {
      plan3({ location: at(c, L + 1), done: is(FIELD_MARKER) });
      return;
    }
    if (key(c) === key(gate!.cell)) {
      fenceSteps.push({
        location: at(c, L + 1),
        done: is(...FENCE_GATES),
        place: (i) => one(at(c, L + 1), i!, { "minecraft:cardinal_direction": gate!.direction }),
        material: { items: FENCE_GATES, source: "input", label: "Fence Gate" },
        solid: true,
      });
      return;
    }
    fenceSteps.push({
      location: at(c, L + 1),
      done: is(...WOODEN_FENCES),
      place: (i) => one(at(c, L + 1), i!, connections(c)),
      material: fence,
      solid: true,
    });
    if (index % 4 === 0) {
      torchSteps.push({
        location: at(c, L + 2),
        done: is(MinecraftBlockTypes.Torch),
        place: () => one(at(c, L + 2), MinecraftBlockTypes.Torch, { torch_facing_direction: "top" }),
        material: torch,
      });
    }
  });

  // 4. facilities
  const facilitySteps: BuildStep[] = [
    chestStep(chests.seeds, chestItem),
    {
      location: at(hopperCell, L + 1),
      done: is(MinecraftBlockTypes.Hopper),
      place: () =>
        one(at(hopperCell, L + 1), MinecraftBlockTypes.Hopper, { facing_direction: hopperFacing(compost.dir) }),
      material: { items: [MinecraftItemTypes.Hopper], source: "input", label: "Hopper" },
      solid: true,
    },
    chestStep(chests.compost, chestItem),
    {
      location: at(composterCell, L + 1),
      done: is(MinecraftBlockTypes.Composter),
      place: () => one(at(composterCell, L + 1), MinecraftBlockTypes.Composter),
      material: { items: [MinecraftItemTypes.Composter], source: "input", label: "Composter" },
      solid: true,
    },
    {
      location: at(composterCell, L),
      done: is(MinecraftBlockTypes.Hopper),
      place: () =>
        one(at(composterCell, L), MinecraftBlockTypes.Hopper, { facing_direction: hopperFacing(compost.dir) }),
      material: { items: [MinecraftItemTypes.Hopper], source: "input", label: "Hopper" },
    },
    chestStep(chests.bone_meal, chestItem),
    {
      location: bed.head,
      done: is(MinecraftBlockTypes.Bed),
      place: () => [
        {
          location: bed.head,
          block: MinecraftBlockTypes.Bed,
          states: { direction: bedDirection.direction, head_piece_bit: true },
        },
        {
          location: bed.foot,
          block: MinecraftBlockTypes.Bed,
          states: { direction: bedDirection.direction, head_piece_bit: false },
        },
      ],
      material: { items: [MinecraftItemTypes.Bed], source: "input", label: "Bed" },
      solid: true,
    },
  ];
  plan3({ location: bed.foot, done: is(MinecraftBlockTypes.Bed) });

  // 5. water and lamp posts
  const waterSteps: BuildStep[] = water.map((c) => ({
    location: at(c, L),
    done: is(MinecraftBlockTypes.Water),
    place: () => one(at(c, L), MinecraftBlockTypes.Water),
    material: {
      items: [MinecraftItemTypes.WaterBucket],
      source: "input",
      returns: MinecraftItemTypes.Bucket,
      label: "Water Bucket",
    },
  }));
  const lampSteps: BuildStep[] = [
    ...lampPosts.map((c) => ({
      location: at(c, L + 1),
      done: is(...WOODEN_FENCES),
      place: (i: string | undefined) => one(at(c, L + 1), i!, connections(c)),
      material: fence,
      solid: true,
    })),
    ...lampPosts.map((c) => ({
      location: at(c, L + 2),
      done: is(MinecraftBlockTypes.Torch),
      place: () => one(at(c, L + 2), MinecraftBlockTypes.Torch, { torch_facing_direction: "top" }),
      material: torch,
    })),
  ];

  // 6. till and plant
  const farmland = farmlandCells.map((c) => at(c, L));
  const tillSteps: BuildStep[] = farmland.map((location) => ({
    location,
    done: is(MinecraftBlockTypes.Farmland),
    keep: dirtLike,
    place: () => one(location, MinecraftBlockTypes.Farmland),
  }));
  const plantSteps: BuildStep[] = farmlandCells.map((c) => ({
    location: at(c, L + 1),
    done: isCrop,
    keep: is(AIR),
    skipIf: { below: (t) => t !== MinecraftBlockTypes.Farmland },
    place: (i) => one(at(c, L + 1), CROPS.find((crop) => crop.seed === i)!.block, { growth: 0 }),
    material: { items: SEED_ITEMS, source: "seeds", label: "Seeds" },
  }));

  for (const s of [
    inputStep,
    leftoversStep,
    ...fenceSteps,
    ...torchSteps,
    ...facilitySteps,
    ...lampSteps,
    ...plantSteps,
  ])
    plan3(s);
  // Crop chests are placed on demand, but their spots must not be cleared away.
  for (const c of CROPS) plan3(chestStep(chests[`crop:${c.produce}`], chestItem));

  // Clearing: everything that isn't planned, from the top down, inside the whole area.
  const clearSteps: BuildStep[] = [];
  for (let y = L + 3; y >= L + 1; y--) {
    for (const c of [...boundary, ...interior]) {
      const location = at(c, y);
      if (!planned.has(`${c.x},${y},${c.z}`)) clearSteps.push({ location, done: is(AIR) });
    }
  }

  steps.push(
    inputStep,
    leftoversStep,
    ...clearSteps,
    ...groundSteps,
    ...fenceSteps,
    ...torchSteps,
    ...facilitySteps,
    ...waterSteps,
    ...lampSteps,
    ...tillSteps,
    ...plantSteps
  );

  return {
    plan: { level, boundary, interior, farmland, chests, bed, steps },
  };
}
