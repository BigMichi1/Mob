import { type Block, type Dimension, type Vector3 } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";
import { isReplaceable, safeGetBlock, SIDES } from "./common";

export const isBedHead = (block: Block | undefined): boolean =>
  block?.typeId === MinecraftBlockTypes.Bed && block.permutation.getState("head_piece_bit") === true;

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
