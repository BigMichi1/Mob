import { type Entity, Player, system, world } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes, MinecraftDimensionTypes } from "@minecraft/vanilla-data";
import { Builder, BUILDER_TYPE } from "./builder";
import { Farmer, FARMER_TYPE } from "./farmer";
import { FIELD_MARKER, markerPlaced, markerRemoved, releaseField } from "./fields";
import { prettyName } from "./common";

/** Ticks between two worker actions (20 ticks = 1 second). */
const ACTION_INTERVAL_TICKS = 20;

const DIMENSIONS = [MinecraftDimensionTypes.Overworld, MinecraftDimensionTypes.Nether, MinecraftDimensionTypes.TheEnd];

const entitiesOfType = (type: string): Entity[] =>
  DIMENSIONS.flatMap((id) => world.getDimension(id).getEntities({ type }));

const allBuilders = (): Builder[] => entitiesOfType(BUILDER_TYPE).map((e) => new Builder(e));
const allFarmers = (): Farmer[] => entitiesOfType(FARMER_TYPE).map((e) => new Farmer(e));

function showShoppingList(player: Player, builder: Builder): void {
  const { done, total } = builder.progress;
  const materials = [...builder.remainingMaterials()].map(([id, count]) => `§e${count}x §f${prettyName(id)}`);
  player.sendMessage(
    materials.length > 0
      ? `§6[Builder]§r ${done}/${total} blocks built. Still needed: ${materials.join("§7, ")}`
      : `§6[Builder]§r ${done}/${total} blocks built. Nothing more needed!`
  );
}

function showFarmerInfo(player: Player, farmer: Farmer): void {
  for (const line of farmer.describe()) player.sendMessage(`§a[Farmer]§r ${line}`);
}

// Main loop: every worker performs at most one action per interval.
system.runInterval(() => {
  for (const worker of [...allBuilders(), ...allFarmers()]) {
    try {
      worker.tick();
    } catch (error) {
      console.warn(`[Workers] tick failed: ${error}`);
    }
  }
}, ACTION_INTERVAL_TICKS);

// Right-click a worker to see its status. Before-events run in read-only mode, so defer the message.
world.beforeEvents.playerInteractWithEntity.subscribe(({ player, target }) => {
  if (target.typeId === BUILDER_TYPE) system.run(() => showShoppingList(player, new Builder(target)));
  if (target.typeId === FARMER_TYPE) system.run(() => showFarmerInfo(player, new Farmer(target)));
});

// Opening a builder's input barrel or a farmer's input chest also shows what is still needed.
world.afterEvents.blockContainerOpened.subscribe(({ block, openSource }) => {
  const player = openSource.entity;
  if (!(player instanceof Player)) return;
  if (block.typeId === MinecraftBlockTypes.Barrel) {
    const builder = allBuilders().find((b) => {
      const barrel = b.barrelLocation;
      return barrel !== undefined && Vector3Utils.equals(barrel, block.location);
    });
    if (builder) showShoppingList(player, builder);
  } else if (block.typeId === MinecraftBlockTypes.Chest) {
    const farmer = allFarmers().find((f) => {
      const input = f.inputChest();
      return input !== undefined && Vector3Utils.equals(input, block.location);
    });
    if (farmer) showFarmerInfo(player, farmer);
  }
});

// Field markers: the order in which a player places them defines the outline of the field.
world.afterEvents.playerPlaceBlock.subscribe(({ block, player }) => {
  if (block.typeId !== FIELD_MARKER) return;
  const count = markerPlaced(player.id, block.dimension.id, block.location);
  player.sendMessage(
    count >= 3
      ? `§a[Farmer]§r Field marker ${count} placed. Spawn a Farmer near the field to start.`
      : `§a[Farmer]§r Field marker ${count} placed - place at least ${3 - count} more.`
  );
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
  if (brokenBlockPermutation.type.id === FIELD_MARKER) markerRemoved(block.dimension.id, block.location);
});

// A dead farmer frees its field for another one.
world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
  if (deadEntity.typeId === FARMER_TYPE) releaseField(deadEntity.id);
});
