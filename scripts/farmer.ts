import {
  type Block,
  BlockComponentTypes,
  BlockPermutation,
  type Container,
  type Dimension,
  type Entity,
  ItemStack,
  type Vector3,
  world,
} from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes, MinecraftItemTypes } from "@minecraft/vanilla-data";
import { center, dropOn, face, findBlockNear, placeBlockNextTo, prettyName, safeGetBlock, setStatus } from "./common";

export const FARMER_TYPE = "mob:farmer";

/** Radius around the collector chest that the farmer treats as its field. */
const FIELD_RADIUS = 8;
/** How close (blocks) the farmer must be to a crop to harvest it. */
const HARVEST_REACH = 3;
/** How close (blocks) the farmer must be to the chest to unload. */
const CHEST_REACH = 3;
/** Radius searched for an existing chest / composter when a farmer is first seen. */
const SEARCH_RADIUS = 4;
/** Items the farmer carries before it walks back to unload. */
const BAG_CAPACITY = 16;
/** Growth state value of a fully grown crop (all four vanilla crops use 0..7). */
const MATURE_GROWTH = 7;
/** Composter fill levels: 7 = full, 8 = bone meal ready. */
const COMPOSTER_FULL = 7;
const COMPOSTER_READY = 8;

/** Crop block -> the item that replants it. */
const CROPS = new Map<string, string>([
  [MinecraftBlockTypes.Wheat, MinecraftItemTypes.WheatSeeds],
  [MinecraftBlockTypes.Carrots, MinecraftItemTypes.Carrot],
  [MinecraftBlockTypes.Potatoes, MinecraftItemTypes.Potato],
  [MinecraftBlockTypes.Beetroot, MinecraftItemTypes.BeetrootSeeds],
]);

/** The "vegetables" that go into the collector chest. Everything else is a leftover for the composter. */
const PRODUCE = new Set<string>([
  MinecraftItemTypes.Wheat,
  MinecraftItemTypes.Carrot,
  MinecraftItemTypes.Potato,
  MinecraftItemTypes.Beetroot,
]);

/**
 * Chance that one item raises the composter's fill level by one.
 * NOTE: values recalled from vanilla Bedrock behaviour and not verified against official documentation.
 * Items not listed here are not composted but dropped next to the composter.
 */
const COMPOST_CHANCE = new Map<string, number>([
  [MinecraftItemTypes.WheatSeeds, 0.3],
  [MinecraftItemTypes.BeetrootSeeds, 0.3],
  [MinecraftItemTypes.Wheat, 0.65],
  [MinecraftItemTypes.Carrot, 0.65],
  [MinecraftItemTypes.Potato, 0.65],
  [MinecraftItemTypes.Beetroot, 0.65],
]);

const Prop = {
  chest: "mob:chest",
  composter: "mob:composter",
  bag: "mob:bag",
  goal: "mob:goal",
} as const;

type Goal = "crops" | "chest" | "none";
const GOAL_EVENTS: Record<Goal, string> = {
  crops: "mob:go_to_crops",
  chest: "mob:go_to_chest",
  none: "mob:stop_moving",
};

type Bag = Record<string, number>;

const isMature = (block: Block): boolean =>
  CROPS.has(block.typeId) && block.permutation.getState("growth") === MATURE_GROWTH;

const bagSize = (bag: Bag): number => Object.values(bag).reduce((sum, n) => sum + n, 0);

/** A farmer's persistent state, stored as dynamic properties on the entity itself. */
class FarmerState {
  constructor(private readonly entity: Entity) {}

  get chest(): Vector3 | undefined {
    return this.entity.getDynamicProperty(Prop.chest) as Vector3 | undefined;
  }
  set chest(value: Vector3 | undefined) {
    this.entity.setDynamicProperty(Prop.chest, value);
  }

  get composter(): Vector3 | undefined {
    return this.entity.getDynamicProperty(Prop.composter) as Vector3 | undefined;
  }
  set composter(value: Vector3 | undefined) {
    this.entity.setDynamicProperty(Prop.composter, value);
  }

  get bag(): Bag {
    const raw = this.entity.getDynamicProperty(Prop.bag) as string | undefined;
    return raw ? (JSON.parse(raw) as Bag) : {};
  }
  set bag(value: Bag) {
    this.entity.setDynamicProperty(Prop.bag, bagSize(value) > 0 ? JSON.stringify(value) : undefined);
  }

  set goal(value: Goal) {
    if (this.entity.getDynamicProperty(Prop.goal) === value) return;
    this.entity.setDynamicProperty(Prop.goal, value);
    // Switches the data-driven move_to_block goal defined in entities/farmer.json.
    this.entity.triggerEvent(GOAL_EVENTS[value]);
  }
}

export class Farmer {
  private readonly state: FarmerState;

  constructor(private readonly entity: Entity) {
    this.state = new FarmerState(entity);
  }

  private get dimension(): Dimension {
    return this.entity.dimension;
  }

  get bag(): Bag {
    return this.state.bag;
  }

  /** Called periodically: performs at most one action (harvest one crop or unload the bag). */
  tick(): void {
    const chestLocation = this.state.chest ?? this.linkChest();
    if (!chestLocation) {
      this.status("needs space for a chest");
      return;
    }
    const chestBlock = safeGetBlock(this.dimension, chestLocation);
    if (!chestBlock) return; // chunk not loaded
    const chest = chestBlock.getComponent(BlockComponentTypes.Inventory)?.container;
    if (chestBlock.typeId !== MinecraftBlockTypes.Chest || !chest) {
      this.state.goal = "none";
      this.status("lost its chest!");
      return;
    }
    const composter = this.linkComposter(chestLocation);
    if (composter) this.ripenComposter(composter);

    const bag = this.state.bag;
    if (bagSize(bag) < BAG_CAPACITY) {
      const nearby = this.findMatureCrop(this.entity.location, HARVEST_REACH);
      if (nearby) {
        this.harvest(nearby, bag);
        return;
      }
      if (this.findMatureCrop(chestLocation, FIELD_RADIUS)) {
        this.state.goal = "crops";
        this.status(bagSize(bag) > 0 ? `harvesting (${bagSize(bag)}/${BAG_CAPACITY})` : "walking to the field");
        return;
      }
    }

    if (bagSize(bag) > 0) {
      this.unload(chestLocation, chest, composter, bag);
      return;
    }

    this.state.goal = "none";
    this.status("waiting for crops to grow");
  }

  /** Finds a chest next to the farmer, or places a new one, and remembers it as the collector box. */
  private linkChest(): Vector3 | undefined {
    const chest =
      findBlockNear(this.dimension, this.entity.location, SEARCH_RADIUS, MinecraftBlockTypes.Chest) ??
      placeBlockNextTo(this.dimension, this.entity.location, BlockPermutation.resolve(MinecraftBlockTypes.Chest));
    if (chest) {
      this.state.chest = chest;
      this.status("ready - plant some crops!");
    }
    return chest;
  }

  /** Returns the composter next to the chest, finding or placing one if needed. */
  private linkComposter(chest: Vector3): Block | undefined {
    const known = this.state.composter;
    const current = known && safeGetBlock(this.dimension, known);
    if (current?.typeId === MinecraftBlockTypes.Composter) return current;

    const location =
      findBlockNear(this.dimension, chest, SEARCH_RADIUS, MinecraftBlockTypes.Composter) ??
      placeBlockNextTo(this.dimension, chest, BlockPermutation.resolve(MinecraftBlockTypes.Composter));
    this.state.composter = location;
    return location && safeGetBlock(this.dimension, location);
  }

  private findMatureCrop(origin: Vector3, radius: number): Block | undefined {
    const o = Vector3Utils.floor(origin);
    for (let y = -2; y <= 1; y++) {
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          const block = safeGetBlock(this.dimension, Vector3Utils.add(o, { x, y, z }));
          if (block && isMature(block)) return block;
        }
      }
    }
    return undefined;
  }

  /** Harvests one mature crop using its vanilla loot table, then replants it with one of the drops. */
  private harvest(block: Block, bag: Bag): void {
    const crop = block.typeId;
    const seed = CROPS.get(crop)!;
    const location = block.location;

    for (const drop of world.getLootTableManager().generateLootFromBlock(block) ?? []) {
      bag[drop.typeId] = (bag[drop.typeId] ?? 0) + drop.amount;
    }

    if ((bag[seed] ?? 0) > 0) {
      bag[seed]--;
      block.setPermutation(BlockPermutation.resolve(crop, { growth: 0 }));
    } else {
      block.setType(MinecraftBlockTypes.Air); // nothing to replant with
    }
    this.state.bag = bag;

    face(this.entity, location);
    this.dimension.spawnParticle("minecraft:crop_growth_emitter", center(location));
    this.dimension.playSound("dig.grass", location);
    this.status(`harvesting (${bagSize(bag)}/${BAG_CAPACITY})`);
  }

  /** Vegetables go into the chest; leftovers and whatever does not fit go into the composter. */
  private unload(chestLocation: Vector3, chest: Container, composter: Block | undefined, bag: Bag): void {
    if (Vector3Utils.distance(this.entity.location, center(chestLocation)) > CHEST_REACH) {
      this.state.goal = "chest";
      this.status(`bringing ${bagSize(bag)} items to the chest`);
      return;
    }

    if (composter) this.emptyComposter(composter, chest);

    for (const [id, count] of Object.entries(bag)) {
      const leftover = PRODUCE.has(id) ? (chest.addItem(new ItemStack(id, count))?.amount ?? 0) : count;
      if (leftover > 0) this.compost(id, leftover, composter ?? safeGetBlock(this.dimension, chestLocation)!);
    }

    this.state.bag = {};
    this.state.goal = "none";
    face(this.entity, chestLocation);
    this.dimension.playSound("random.chestclosed", chestLocation);
    this.status(chest.emptySlotsCount === 0 ? "chest is full!" : "unloaded the harvest");
  }

  /** Puts items into the composter one by one; anything it can't take is dropped next to it. */
  private compost(id: string, count: number, target: Block): void {
    const chance = COMPOST_CHANCE.get(id);
    let remaining = count;
    if (target.typeId === MinecraftBlockTypes.Composter && chance !== undefined) {
      let level = (target.permutation.getState("composter_fill_level") as number | undefined) ?? 0;
      while (remaining > 0 && level < COMPOSTER_FULL) {
        remaining--;
        if (Math.random() < chance) level++;
      }
      target.setPermutation(target.permutation.withState("composter_fill_level", level));
      this.dimension.spawnParticle("minecraft:crop_growth_emitter", center(target.location));
    }
    if (remaining > 0) dropOn(this.dimension, target.location, id, remaining);
  }

  /** Vanilla turns a full composter into a ready one shortly after; setting the state ourselves skips that delay. */
  private ripenComposter(composter: Block): void {
    if (composter.permutation.getState("composter_fill_level") === COMPOSTER_FULL) {
      composter.setPermutation(composter.permutation.withState("composter_fill_level", COMPOSTER_READY));
    }
  }

  /** Takes the bone meal out of a ready composter and stores it in the chest (or drops it if the chest is full). */
  private emptyComposter(composter: Block, chest: Container): void {
    if (composter.permutation.getState("composter_fill_level") !== COMPOSTER_READY) return;
    composter.setPermutation(composter.permutation.withState("composter_fill_level", 0));
    const leftover = chest.addItem(new ItemStack(MinecraftItemTypes.BoneMeal));
    if (leftover) dropOn(this.dimension, composter.location, leftover);
    this.dimension.playSound("block.composter.empty", composter.location);
  }

  private status(text: string): void {
    setStatus(this.entity, "Farmer", text);
  }
}

export const describeBag = (bag: Bag): string =>
  Object.entries(bag)
    .map(([id, count]) => `§e${count}x §f${prettyName(id)}`)
    .join("§7, ");
