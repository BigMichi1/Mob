import { Player, system, world } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes, MinecraftDimensionTypes } from "@minecraft/vanilla-data";
import { Builder, BUILDER_TYPE, prettyName } from "./builder";

/** Ticks between two builder actions (20 ticks = 1 second). */
const ACTION_INTERVAL_TICKS = 20;

const DIMENSIONS = [MinecraftDimensionTypes.Overworld, MinecraftDimensionTypes.Nether, MinecraftDimensionTypes.TheEnd];

const allBuilders = (): Builder[] =>
  DIMENSIONS.flatMap((id) => world.getDimension(id).getEntities({ type: BUILDER_TYPE })).map((e) => new Builder(e));

function showShoppingList(player: Player, builder: Builder): void {
  const { done, total } = builder.progress;
  const materials = [...builder.remainingMaterials()].map(([id, count]) => `§e${count}x §f${prettyName(id)}`);
  player.sendMessage(
    materials.length > 0
      ? `§6[Builder]§r ${done}/${total} blocks built. Still needed: ${materials.join("§7, ")}`
      : `§6[Builder]§r ${done}/${total} blocks built. Nothing more needed!`
  );
}

// Main loop: every builder performs at most one action per interval.
system.runInterval(() => {
  for (const builder of allBuilders()) {
    try {
      builder.tick();
    } catch (error) {
      console.warn(`[Builder] tick failed: ${error}`);
    }
  }
}, ACTION_INTERVAL_TICKS);

// Right-click a builder to see what it still needs. Before-events run in read-only mode, so defer the message.
world.beforeEvents.playerInteractWithEntity.subscribe(({ player, target }) => {
  if (target.typeId === BUILDER_TYPE) system.run(() => showShoppingList(player, new Builder(target)));
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
