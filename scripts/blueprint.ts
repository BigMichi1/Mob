import type { Vector3 } from "@minecraft/server";
import { MinecraftBlockTypes } from "@minecraft/vanilla-data";

/** One block of the house: offset relative to the house origin and the block (= item) to place. */
export interface BlueprintStep {
  readonly offset: Vector3;
  readonly block: MinecraftBlockTypes;
}

/**
 * Legend for the layer drawings below. Every block listed here is also a valid item id,
 * so the item the player puts into the barrel is exactly the block that gets placed.
 * `.` means "leave empty" (door opening, interior air).
 */
const LEGEND: Readonly<Record<string, MinecraftBlockTypes | undefined>> = {
  C: MinecraftBlockTypes.Cobblestone,
  L: MinecraftBlockTypes.OakLog,
  P: MinecraftBlockTypes.OakPlanks,
  G: MinecraftBlockTypes.Glass,
  ".": undefined,
};

/**
 * A 5x5 starter house, drawn bottom-up. Each string is one row along +z, each character one block along +x.
 * The door opening is on the west side (x = 0, z = 2), facing the barrel.
 */
const LAYERS: readonly (readonly string[])[] = [
  // y = 0: floor
  ["CCCCC", "CCCCC", "CCCCC", "CCCCC", "CCCCC"],
  // y = 1: walls with door opening
  ["LPPPL", "P...P", "....P", "P...P", "LPPPL"],
  // y = 2: walls with door opening and windows
  ["LPGPL", "P...P", "....G", "P...P", "LPGPL"],
  // y = 3: top of walls
  ["LPPPL", "P...P", "P...P", "P...P", "LPPPL"],
  // y = 4: roof
  ["PPPPP", "PPPPP", "PPPPP", "PPPPP", "PPPPP"],
];

/** The ordered build plan: layer by layer, row by row. */
export const BLUEPRINT: readonly BlueprintStep[] = LAYERS.flatMap((rows, y) =>
  rows.flatMap((row, z) =>
    [...row].flatMap((char, x) => {
      const block = LEGEND[char];
      return block ? [{ offset: { x, y, z }, block }] : [];
    })
  )
);

/** Where the house starts relative to the input barrel: 2 blocks east, centered on the barrel's z. */
export const HOUSE_OFFSET_FROM_BARREL: Vector3 = { x: 2, y: 0, z: -2 };
