import {
  type Block,
  type BlockPermutation,
  type Dimension,
  type Entity,
  ItemStack,
  type Vector3,
} from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";

/** Blocks a worker may overwrite (everything else is treated as an obstacle and left alone). */
const REPLACEABLE = new Set<string>([
  MinecraftBlockTypes.ShortGrass,
  MinecraftBlockTypes.TallGrass,
  MinecraftBlockTypes.Fern,
  MinecraftBlockTypes.LargeFern,
  MinecraftBlockTypes.Deadbush,
  MinecraftBlockTypes.SnowLayer,
]);

/** "minecraft:oak_planks" -> "Oak Planks" */
export const prettyName = (id: string): string =>
  id
    .replace(/^.*:/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export const center = (v: Vector3): Vector3 => Vector3Utils.add(v, { x: 0.5, y: 0.5, z: 0.5 });

export const safeGetBlock = (dimension: Dimension, location: Vector3): Block | undefined => {
  try {
    return dimension.getBlock(location);
  } catch {
    return undefined; // outside the world or chunk not loaded
  }
};

export const isReplaceable = (block: Block): boolean => block.isAir || block.isLiquid || REPLACEABLE.has(block.typeId);

/** Yields every block location in a box around `origin` (horizontal radius, vertical range). */
export function* around(origin: Vector3, radius: number, minY: number, maxY: number): Generator<Vector3> {
  const o = Vector3Utils.floor(origin);
  for (let y = minY; y <= maxY; y++)
    for (let x = -radius; x <= radius; x++)
      for (let z = -radius; z <= radius; z++) yield Vector3Utils.add(o, { x, y, z });
}

/** Finds the first block of the given type in a small box around `origin`. */
export function findBlockNear(
  dimension: Dimension,
  origin: Vector3,
  radius: number,
  typeId: string
): Vector3 | undefined {
  for (const location of around(origin, radius, -1, 2)) {
    if (safeGetBlock(dimension, location)?.typeId === typeId) return location;
  }
  return undefined;
}

/** The four horizontal neighbours. */
export const SIDES: readonly Vector3[] = [
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: 1, y: 0, z: 0 },
];

/** Places a block on the first free side next to `origin` and returns where it went. */
export function placeBlockNextTo(
  dimension: Dimension,
  origin: Vector3,
  permutation: BlockPermutation
): Vector3 | undefined {
  for (const side of SIDES) {
    const location = Vector3Utils.add(Vector3Utils.floor(origin), side);
    const block = safeGetBlock(dimension, location);
    if (block && isReplaceable(block)) {
      block.setPermutation(permutation);
      return location;
    }
  }
  return undefined;
}

/** Drops an item on top of the given block location. */
export const dropOn = (dimension: Dimension, location: Vector3, item: ItemStack | string, amount = 1): void => {
  const stack = typeof item === "string" ? new ItemStack(item, amount) : item;
  dimension.spawnItem(stack, Vector3Utils.add(location, { x: 0.5, y: 1.2, z: 0.5 }));
};

/** Shows a two-line name tag ("Title" + grey status line); only writes when it changed. */
export const setStatus = (entity: Entity, title: string, text: string): void => {
  const tag = `${title}\n§7${text}`;
  if (entity.nameTag !== tag) entity.nameTag = tag;
};

/** Turns the entity's head/body towards a location without moving it. */
export const face = (entity: Entity, location: Vector3): void =>
  entity.teleport(entity.location, { facingLocation: center(location) });
