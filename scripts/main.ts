import { type Entity, Player, system, world } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes, MinecraftDimensionTypes } from "@minecraft/vanilla-data";
import { Builder, BUILDER_TYPE } from "./builder";
import { describeBag, Farmer, FARMER_TYPE } from "./farmer";
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

function showFarmerBag(player: Player, farmer: Farmer): void {
  const bag = describeBag(farmer.bag);
  player.sendMessage(`§a[Farmer]§r ${bag ? `Carrying: ${bag}` : "Carrying nothing right now."}`);
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
  if (target.typeId === FARMER_TYPE) system.run(() => showFarmerBag(player, new Farmer(target)));
});

// Opening a builder's input barrel also shows the shopping list.
world.afterEvents.blockContainerOpened.subscribe(({ block, openSource }) => {
  const player = openSource.entity;
  if (block.typeId !== MinecraftBlockTypes.Barrel || !(player instanceof Player)) return;
  const builder = allBuilders().find((b) => {
    const barrel = b.barrelLocation;
    return barrel !== undefined && Vector3Utils.equals(barrel, block.location);
  });
  if (builder) showShoppingList(player, builder);
});
