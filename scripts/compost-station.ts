import { BlockPermutation, type Container, type Dimension, type Vector3 } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";
import { isReplaceable, safeGetBlock, SIDES } from "./common";

/**
 * A compost station: chest -> hopper -> composter, built by the farmer next to its collector chest.
 *
 *   [chest]
 *   [hopper] -> [composter]
 *
 * Filling the composter is left completely to vanilla mechanics: the hopper pulls items out of the chest
 * above it and pushes them into the composter, which applies the vanilla compost chances.
 */
export interface CompostStation {
  readonly composter: Vector3;
  readonly hopper: Vector3;
  readonly chest: Vector3;
}

/** Hopper `facing_direction` values (0 = down, 2 = north/-z, 3 = south/+z, 4 = west/-x, 5 = east/+x). */
const hopperFacing = (from: Vector3, to: Vector3): number => {
  const d = Vector3Utils.subtract(to, from);
  if (d.x < 0) return 4;
  if (d.x > 0) return 5;
  if (d.z < 0) return 2;
  return 3;
};

const UP: Vector3 = { x: 0, y: 1, z: 0 };
const CHESTS = new Set<string>([MinecraftBlockTypes.Chest, MinecraftBlockTypes.TrappedChest]);

export function isIntact(dimension: Dimension, station: CompostStation): boolean {
  return (
    safeGetBlock(dimension, station.composter)?.typeId === MinecraftBlockTypes.Composter &&
    safeGetBlock(dimension, station.hopper)?.typeId === MinecraftBlockTypes.Hopper &&
    safeGetBlock(dimension, station.chest)?.typeId === MinecraftBlockTypes.Chest
  );
}

export const stationChest = (dimension: Dimension, station: CompostStation): Container | undefined =>
  safeGetBlock(dimension, station.chest)?.getComponent("minecraft:inventory")?.container;

/** Builds (or completes) a compost station next to the collector chest. Returns undefined if there is no room. */
export function buildStation(dimension: Dimension, collector: Vector3): CompostStation | undefined {
  for (const composterSide of SIDES) {
    const composter = Vector3Utils.add(collector, composterSide);
    const composterBlock = safeGetBlock(dimension, composter);
    if (!composterBlock) continue;
    const hasComposter = composterBlock.typeId === MinecraftBlockTypes.Composter;
    if (!hasComposter && !isReplaceable(composterBlock)) continue;

    for (const hopperSide of SIDES) {
      const hopper = Vector3Utils.add(composter, hopperSide);
      if (Vector3Utils.equals(hopper, collector)) continue;
      const chest = Vector3Utils.add(hopper, UP);
      const hopperBlock = safeGetBlock(dimension, hopper);
      const chestBlock = safeGetBlock(dimension, chest);
      if (!hopperBlock || !chestBlock || !isReplaceable(hopperBlock) || !isReplaceable(chestBlock)) continue;
      // Two chests next to each other merge into a double chest - keep the compost chest on its own.
      const touchesChest = SIDES.some((side) =>
        CHESTS.has(safeGetBlock(dimension, Vector3Utils.add(chest, side))?.typeId ?? "")
      );
      if (touchesChest) continue;

      if (!hasComposter) composterBlock.setPermutation(BlockPermutation.resolve(MinecraftBlockTypes.Composter));
      hopperBlock.setPermutation(
        BlockPermutation.resolve(MinecraftBlockTypes.Hopper, { facing_direction: hopperFacing(hopper, composter) })
      );
      chestBlock.setPermutation(BlockPermutation.resolve(MinecraftBlockTypes.Chest));
      return { composter, hopper, chest };
    }
  }
  return undefined;
}
