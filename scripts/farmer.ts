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
import { bedFoot, findBedHead, isBedHead, placeBed, spotNextToBed } from "./bed";
import { center, dropOn, face, findBlockNear, placeBlockNextTo, prettyName, safeGetBlock, setStatus } from "./common";
import { buildStation, type CompostStation, isIntact, stationChest } from "./compost-station";

export const FARMER_TYPE = "mob:farmer";

/** Radius around the collector chest that the farmer treats as its field. */
const FIELD_RADIUS = 8;
/** Radius around the collector chest in which the farmer looks for a bed. */
const BED_RADIUS = 10;
/** How close (blocks) the farmer must be to a crop to harvest it. */
const HARVEST_REACH = 3;
/** How close (blocks) the farmer must be to the chest to unload, or to its bed to lie down. */
const CHEST_REACH = 3;
const BED_REACH = 2;
/** Radius searched for an existing chest when a farmer is first seen. */
const SEARCH_RADIUS = 4;
/** Items the farmer carries before it walks back to unload. */
const BAG_CAPACITY = 16;
/** Growth state value of a fully grown crop (all four vanilla crops use 0..7). */
const MATURE_GROWTH = 7;
/** Composter fill level at which bone meal is ready. */
const COMPOSTER_READY = 8;
/** Night as used for player sleeping (ticks of the day, 0..24000). */
const NIGHT_START = 12542;
const NIGHT_END = 23460;
/** Height of a bed's top surface. */
const BED_HEIGHT = 0.5625;

/** Crop block -> the item that replants it. */
const CROPS = new Map<string, string>([
  [MinecraftBlockTypes.Wheat, MinecraftItemTypes.WheatSeeds],
  [MinecraftBlockTypes.Carrots, MinecraftItemTypes.Carrot],
  [MinecraftBlockTypes.Potatoes, MinecraftItemTypes.Potato],
  [MinecraftBlockTypes.Beetroot, MinecraftItemTypes.BeetrootSeeds],
]);

/** The "vegetables" that go into the collector chest. */
const PRODUCE = new Set<string>([
  MinecraftItemTypes.Wheat,
  MinecraftItemTypes.Carrot,
  MinecraftItemTypes.Potato,
  MinecraftItemTypes.Beetroot,
]);

/** Leftovers that go into the compost chest (all of them are accepted by a vanilla composter). */
const COMPOSTABLE = new Set<string>([...PRODUCE, MinecraftItemTypes.WheatSeeds, MinecraftItemTypes.BeetrootSeeds]);

const Prop = {
  chest: "mob:chest",
  station: "mob:station",
  bed: "mob:bed",
  bag: "mob:bag",
  goal: "mob:goal",
} as const;

/** Entity property (entities/farmer.json) that drives the sleeping pose in the resource pack. */
const SLEEPING_PROPERTY = "mob:sleeping";

type Goal = "crops" | "chest" | "bed" | "none";
const GOAL_EVENTS: Record<Goal, string> = {
  crops: "mob:go_to_crops",
  chest: "mob:go_to_chest",
  bed: "mob:go_to_bed",
  none: "mob:stop_moving",
};

type Bag = Record<string, number>;

const isMature = (block: Block): boolean =>
  CROPS.has(block.typeId) && block.permutation.getState("growth") === MATURE_GROWTH;

const bagSize = (bag: Bag): number => Object.values(bag).reduce((sum, n) => sum + n, 0);

const isNight = (): boolean => {
  const time = world.getTimeOfDay();
  return time >= NIGHT_START && time < NIGHT_END;
};

/** A farmer's persistent state, stored as dynamic properties on the entity itself. */
class FarmerState {
  constructor(private readonly entity: Entity) {}

  private json<T>(key: string): T | undefined {
    const raw = this.entity.getDynamicProperty(key) as string | undefined;
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  get chest(): Vector3 | undefined {
    return this.entity.getDynamicProperty(Prop.chest) as Vector3 | undefined;
  }
  set chest(value: Vector3 | undefined) {
    this.entity.setDynamicProperty(Prop.chest, value);
  }

  get station(): CompostStation | undefined {
    return this.json<CompostStation>(Prop.station);
  }
  set station(value: CompostStation | undefined) {
    this.entity.setDynamicProperty(Prop.station, value && JSON.stringify(value));
  }

  get bed(): Vector3 | undefined {
    return this.entity.getDynamicProperty(Prop.bed) as Vector3 | undefined;
  }
  set bed(value: Vector3 | undefined) {
    this.entity.setDynamicProperty(Prop.bed, value);
  }

  get bag(): Bag {
    return this.json<Bag>(Prop.bag) ?? {};
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

  get sleeping(): boolean {
    return this.entity.getProperty(SLEEPING_PROPERTY) === true;
  }
  set sleeping(value: boolean) {
    if (value === this.sleeping) return;
    this.entity.setProperty(SLEEPING_PROPERTY, value);
    // Freezes / unfreezes the farmer (component group "mob:asleep").
    this.entity.triggerEvent(value ? "mob:fall_asleep" : "mob:wake_up");
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

  /** Called periodically: performs at most one action (sleep, harvest one crop or unload the bag). */
  tick(): void {
    const chestLocation = this.state.chest ?? this.linkChest();
    if (!chestLocation) {
      this.status("needs space for a chest");
      return;
    }

    if (isNight()) {
      this.night(chestLocation);
      return;
    }
    if (this.state.sleeping) this.wakeUp();

    const chestBlock = safeGetBlock(this.dimension, chestLocation);
    if (!chestBlock) return; // chunk not loaded
    const chest = chestBlock.getComponent(BlockComponentTypes.Inventory)?.container;
    if (chestBlock.typeId !== MinecraftBlockTypes.Chest || !chest) {
      this.state.goal = "none";
      this.status("lost its chest!");
      return;
    }

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
      this.unload(chestLocation, chest, bag);
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

  /** Returns the compost station next to the chest, building it (again) if a part is missing. */
  private linkStation(chest: Vector3): CompostStation | undefined {
    const known = this.state.station;
    if (known && isIntact(this.dimension, known)) return known;
    const built = buildStation(this.dimension, chest);
    this.state.station = built;
    return built;
  }

  /** Returns the farmer's bed (head piece), finding or placing one near the chest. */
  private linkBed(chest: Vector3): Block | undefined {
    const known = this.state.bed;
    const current = known && safeGetBlock(this.dimension, known);
    if (current && isBedHead(current)) return current;
    const location = findBedHead(this.dimension, chest, BED_RADIUS) ?? placeBed(this.dimension, chest);
    this.state.bed = location;
    return location && safeGetBlock(this.dimension, location);
  }

  private night(chest: Vector3): void {
    const bed = this.linkBed(chest);
    if (!bed) {
      if (this.state.sleeping) this.wakeUp();
      this.state.goal = "none";
      this.status("no room for a bed");
      return;
    }
    if (this.state.sleeping) {
      this.status("Zzz...");
      return;
    }
    if (Vector3Utils.distance(this.entity.location, center(bed.location)) > BED_REACH) {
      this.state.goal = "bed";
      this.status("going to bed");
      return;
    }
    this.fallAsleep(bed);
  }

  private fallAsleep(head: Block): void {
    const foot = bedFoot(head);
    this.state.goal = "none";
    this.state.sleeping = true;
    // Lie on the head piece, looking towards the foot of the bed.
    this.entity.teleport(
      { x: head.location.x + 0.5, y: head.location.y + BED_HEIGHT, z: head.location.z + 0.5 },
      { facingLocation: Vector3Utils.add(center(foot), { x: 0, y: BED_HEIGHT - 0.5, z: 0 }) }
    );
    this.status("Zzz...");
  }

  private wakeUp(): void {
    this.state.sleeping = false;
    // Step out of bed onto the floor next to it.
    const bed = this.state.bed;
    const spot = bed && spotNextToBed(this.dimension, bed);
    if (spot) this.entity.teleport({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
    this.status("good morning!");
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

  /**
   * Vegetables go into the collector chest. Leftovers - and vegetables that don't fit - go into the
   * compost chest, from where the hopper feeds the composter. Whatever still doesn't fit is dropped.
   */
  private unload(chestLocation: Vector3, chest: Container, bag: Bag): void {
    if (Vector3Utils.distance(this.entity.location, center(chestLocation)) > CHEST_REACH) {
      this.state.goal = "chest";
      this.status(`bringing ${bagSize(bag)} items to the chest`);
      return;
    }

    const station = this.linkStation(chestLocation);
    const compostChest = station && stationChest(this.dimension, station);
    if (station) this.emptyComposter(station, chest);

    for (const [id, count] of Object.entries(bag)) {
      let rest: ItemStack | undefined = new ItemStack(id, count);
      if (PRODUCE.has(id) || !COMPOSTABLE.has(id)) rest = chest.addItem(rest);
      if (rest && compostChest && COMPOSTABLE.has(id)) rest = compostChest.addItem(rest);
      if (rest) dropOn(this.dimension, station?.chest ?? chestLocation, rest);
    }

    this.state.bag = {};
    this.state.goal = "none";
    face(this.entity, chestLocation);
    this.dimension.playSound("random.chestclosed", chestLocation);
    if (!station) this.status("no room for a compost station");
    else this.status(chest.emptySlotsCount === 0 ? "chest is full!" : "unloaded the harvest");
  }

  /** Takes the bone meal out of a ready composter and stores it in the chest (or drops it if the chest is full). */
  private emptyComposter(station: CompostStation, chest: Container): void {
    const composter = safeGetBlock(this.dimension, station.composter);
    if (composter?.permutation.getState("composter_fill_level") !== COMPOSTER_READY) return;
    composter.setPermutation(composter.permutation.withState("composter_fill_level", 0));
    const leftover = chest.addItem(new ItemStack(MinecraftItemTypes.BoneMeal));
    if (leftover) dropOn(this.dimension, station.composter, leftover);
    this.dimension.playSound("block.composter.empty", station.composter);
  }

  private status(text: string): void {
    setStatus(this.entity, "Farmer", text);
  }
}

export const describeBag = (bag: Bag): string =>
  Object.entries(bag)
    .map(([id, count]) => `§e${count}x §f${prettyName(id)}`)
    .join("§7, ");
