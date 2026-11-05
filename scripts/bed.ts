import { type Block, BlockPermutation, type Dimension, type Vector3 } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";
import { around, isReplaceable, safeGetBlock, SIDES } from "./common";

/**
 * Bed `direction` state -> offset from the foot to the head piece.
 * NOTE: mapping (0 = south, 1 = west, 2 = north, 3 = east) follows the legacy Bedrock direction convention
 * and still has to be verified in game.
 */
const BED_DIRECTIONS: readonly { direction: number; toHead: Vector3 }[] = [
  { direction: 0, toHead: { x: 0, y: 0, z: 1 } },
  { direction: 1, toHead: { x: -1, y: 0, z: 0 } },
  { direction: 2, toHead: { x: 0, y: 0, z: -1 } },
  { direction: 3, toHead: { x: 1, y: 0, z: 0 } },
];

const DOWN: Vector3 = { x: 0, y: -1, z: 0 };

export const isBedHead = (block: Block | undefined): boolean =>
  block?.typeId === MinecraftBlockTypes.Bed && block.permutation.getState("head_piece_bit") === true;

/** The foot piece that belongs to a bed head (the head is `toHead` away from the foot). */
export function bedFoot(head: Block): Vector3 {
  const direction = head.permutation.getState("direction");
  const toHead = BED_DIRECTIONS.find((d) => d.direction === direction)?.toHead ?? { x: 0, y: 0, z: 0 };
  return Vector3Utils.subtract(head.location, toHead);
}

export function findBedHead(dimension: Dimension, origin: Vector3, radius: number): Vector3 | undefined {
  for (const location of around(origin, radius, -1, 1)) {
    if (isBedHead(safeGetBlock(dimension, location))) return location;
  }
  return undefined;
}

/** A spot can hold a bed piece if it is free and stands on solid ground (not on the field). */
const canHoldBed = (dimension: Dimension, location: Vector3): boolean => {
  const block = safeGetBlock(dimension, location);
  const below = safeGetBlock(dimension, Vector3Utils.add(location, DOWN));
  return (
    !!block && !!below && isReplaceable(block) && !isReplaceable(below) && below.typeId !== MinecraftBlockTypes.Farmland
  );
};

/** Places a bed close to `origin` (2-3 blocks away) and returns the location of its head piece. */
export function placeBed(dimension: Dimension, origin: Vector3): Vector3 | undefined {
  for (const foot of around(origin, 3, 0, 0)) {
    const distance = Vector3Utils.distance(foot, Vector3Utils.floor(origin));
    if (distance < 2) continue; // keep the area right next to the chest free
    for (const { direction, toHead } of BED_DIRECTIONS) {
      const head = Vector3Utils.add(foot, toHead);
      if (!canHoldBed(dimension, foot) || !canHoldBed(dimension, head)) continue;
      safeGetBlock(dimension, head)!.setPermutation(
        BlockPermutation.resolve(MinecraftBlockTypes.Bed, { direction, head_piece_bit: true })
      );
      safeGetBlock(dimension, foot)!.setPermutation(
        BlockPermutation.resolve(MinecraftBlockTypes.Bed, { direction, head_piece_bit: false })
      );
      return head;
    }
  }
  return undefined;
}

/** A free spot next to the bed where the farmer can stand after waking up. */
export function spotNextToBed(dimension: Dimension, head: Vector3): Vector3 | undefined {
  for (const side of SIDES) {
    const spot = Vector3Utils.add(head, side);
    const block = safeGetBlock(dimension, spot);
    const above = safeGetBlock(dimension, Vector3Utils.add(spot, { x: 0, y: 1, z: 0 }));
    if (block && above && isReplaceable(block) && isReplaceable(above)) return spot;
  }
  return undefined;
}
