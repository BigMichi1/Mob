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
import { MinecraftBlockTypes, MinecraftEntityTypes, MinecraftItemTypes } from "@minecraft/vanilla-data";
import { isBedHead, spotNextToBed } from "./bed";
import { center, dropOn, face, prettyName, safeGetBlock, setStatus } from "./common";
import { type BuildStep, type ChestRole, CROPS, FIELD_MARKER, type FieldPlan, type Material } from "./field-plan";
import { type Field, fieldFor, planFor } from "./fields";

export const FARMER_TYPE = "mob:farmer";

/** How close (blocks) the farmer must be to a crop to harvest it. */
const HARVEST_REACH = 3;
/** How close (blocks) the farmer must be to a chest to use it (covers the whole cluster of chests at the gate). */
const CHEST_REACH = 7;
/** How close (blocks) the farmer must be to a spot to build there. */
const BUILD_REACH = 12;
const BED_REACH = 2;
/** Items the farmer carries before it walks back to unload. */
const BAG_CAPACITY = 16;
/** Building material the farmer takes out of a chest at once, and how many kinds it carries at most. */
const CARRY_MAX = 16;
const CARRY_KINDS = 4;
/** Build actions per tick (one tick of the main loop = 1 second). */
const BUILD_ACTIONS_PER_TICK = 3;
/** Plan steps checked per tick, to spread the cost of scanning large fields. */
const SCAN_LIMIT = 400;
/** Ticks the farmer waits after finishing the plan before it checks the whole field again (repairs, replanting). */
const REPAIR_INTERVAL = 30;
const MATURE_GROWTH = 7;
/** Night as used for player sleeping (ticks of the day, 0..24000). */
const NIGHT_START = 12542;
const NIGHT_END = 23460;
const BED_HEIGHT = 0.5625;

const PRODUCE = new Set(CROPS.map((c) => c.produce));
const SEEDS = new Set(CROPS.map((c) => c.seed));
/** Leftovers for the compost chest (all accepted by a vanilla composter). */
const COMPOSTABLE = new Set<string>([...PRODUCE, ...SEEDS]);
const CROP_BLOCKS = new Set(CROPS.map((c) => c.block));
const NON_BLOCKING_ENTITIES = ["minecraft:item", MinecraftEntityTypes.XpOrb];

const Prop = {
  field: "mob:field",
  version: "mob:version",
  cursor: "mob:cursor",
  idle: "mob:idle",
  carry: "mob:carry",
  bag: "mob:bag",
  goal: "mob:goal",
} as const;
const SLEEPING_PROPERTY = "mob:sleeping";

type Goal = "crops" | "chest" | "bed" | "field" | "none";
const GOAL_EVENTS: Record<Goal, string> = {
  crops: "mob:go_to_crops",
  chest: "mob:go_to_chest",
  bed: "mob:go_to_bed",
  field: "mob:go_to_field",
  none: "mob:stop_moving",
};

type Bag = Record<string, number>;
/** Building material the farmer carries: item id -> amount and the chest it came from. */
type Carry = Record<string, { count: number; source: ChestRole }>;
type Outcome = "done" | "wait";

const bagSize = (bag: Bag): number => Object.values(bag).reduce((sum, n) => sum + n, 0);
const up = (v: Vector3, n = 1): Vector3 => ({ x: v.x, y: v.y + n, z: v.z });
const isNight = (): boolean => {
  const time = world.getTimeOfDay();
  return time >= NIGHT_START && time < NIGHT_END;
};
const containerAt = (dimension: Dimension, location: Vector3): Container | undefined =>
  safeGetBlock(dimension, location)?.getComponent(BlockComponentTypes.Inventory)?.container;

/** A farmer's persistent state, stored as dynamic properties on the entity itself. */
class FarmerState {
  constructor(private readonly entity: Entity) {}

  private get<T>(key: string): T | undefined {
    return this.entity.getDynamicProperty(key) as T | undefined;
  }
  private set(key: string, value: string | number | undefined): void {
    this.entity.setDynamicProperty(key, value);
  }
  private json<T>(key: string): T | undefined {
    const raw = this.get<string>(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  get fieldId(): string | undefined {
    return this.get(Prop.field);
  }
  set fieldId(value: string | undefined) {
    if (value !== this.fieldId) this.set(Prop.field, value);
  }
  get version(): number | undefined {
    return this.get(Prop.version);
  }
  set version(value: number) {
    this.set(Prop.version, value);
  }
  get cursor(): number {
    return this.get(Prop.cursor) ?? 0;
  }
  set cursor(value: number) {
    if (value !== this.cursor) this.set(Prop.cursor, value);
  }
  get idle(): number {
    return this.get(Prop.idle) ?? 0;
  }
  set idle(value: number) {
    this.set(Prop.idle, value);
  }
  get carry(): Carry {
    return this.json<Carry>(Prop.carry) ?? {};
  }
  set carry(value: Carry) {
    const cleaned = Object.fromEntries(Object.entries(value).filter(([, c]) => c.count > 0));
    this.set(Prop.carry, Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : undefined);
  }
  get bag(): Bag {
    return this.json<Bag>(Prop.bag) ?? {};
  }
  set bag(value: Bag) {
    const cleaned = Object.fromEntries(Object.entries(value).filter(([, n]) => n > 0));
    this.set(Prop.bag, bagSize(cleaned) > 0 ? JSON.stringify(cleaned) : undefined);
  }
  set goal(value: Goal) {
    if (this.get(Prop.goal) === value) return;
    this.set(Prop.goal, value);
    // Switches the data-driven move_to_block goals defined in entities/farmer.json.
    this.entity.triggerEvent(GOAL_EVENTS[value]);
  }
  get sleeping(): boolean {
    return this.entity.getProperty(SLEEPING_PROPERTY) === true;
  }
  set sleeping(value: boolean) {
    if (value === this.sleeping) return;
    this.entity.setProperty(SLEEPING_PROPERTY, value);
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

  /** The field and its plan, or a reason why there is none. */
  private context(): { field: Field; plan: FieldPlan } | { problem: string } {
    const field = fieldFor(this.entity, this.state.fieldId);
    if (!field) return { problem: "mark a field: place 3+ Field Markers nearby" };
    this.state.fieldId = field.id;
    const result = planFor(field);
    if ("error" in result) return { problem: result.error };
    if (this.state.version !== field.version) {
      this.state.version = field.version;
      this.state.cursor = 0;
    }
    return { field, plan: result.plan };
  }

  /** Called once per second. */
  tick(): void {
    const ctx = this.context();
    if ("problem" in ctx) {
      if (this.state.sleeping) this.wakeUp(undefined);
      this.state.goal = "none";
      this.status(ctx.problem);
      return;
    }
    const { plan } = ctx;

    if (isNight()) {
      this.night(plan);
      return;
    }
    if (this.state.sleeping) this.wakeUp(plan);

    const bag = this.state.bag;
    if (bagSize(bag) < BAG_CAPACITY) {
      const nearby = this.findMatureCrop(plan, HARVEST_REACH);
      if (nearby) {
        this.harvest(nearby, bag);
        return;
      }
      if (this.findMatureCrop(plan, Infinity)) {
        this.state.goal = "crops";
        this.status(`harvesting (${bagSize(bag)}/${BAG_CAPACITY})`);
        return;
      }
    }
    if (bagSize(bag) > 0 && this.unload(plan, bag) === "wait") return;

    this.build(plan);
  }

  // --- building ---------------------------------------------------------------------------------------

  private build(plan: FieldPlan): void {
    for (let action = 0; action < BUILD_ACTIONS_PER_TICK; action++) {
      const next = this.nextStep(plan);
      if (next === "scanning") return;
      if (!next) {
        if (Object.keys(this.state.carry).length > 0) {
          this.returnCarried(plan);
          return;
        }
        this.state.goal = "none";
        this.status("tending the field");
        if (++this.state.idle >= REPAIR_INTERVAL) this.state.cursor = 0; // look over the whole field again
        return;
      }
      this.state.idle = 0;
      if (this.work(next.step, next.block, plan) === "wait") return;
    }
  }

  /** Finds the next step that still needs work, starting at the saved cursor. */
  private nextStep(plan: FieldPlan): { step: BuildStep; block: Block } | "scanning" | undefined {
    const steps = plan.steps;
    let i = this.state.cursor;
    try {
      for (let scanned = 0; i < steps.length; i++, scanned++) {
        if (scanned >= SCAN_LIMIT) return "scanning";
        const step = steps[i];
        const block = safeGetBlock(this.dimension, step.location);
        if (!block) return "scanning"; // not loaded
        if (block.typeId === FIELD_MARKER || step.done(block.typeId)) continue;
        if (step.skipIf && step.skipIf.below(safeGetBlock(this.dimension, up(step.location, -1))?.typeId ?? ""))
          continue;
        return { step, block };
      }
      return undefined;
    } finally {
      this.state.cursor = i;
    }
  }

  private work(step: BuildStep, block: Block, plan: FieldPlan): Outcome {
    if (Vector3Utils.distance(this.entity.location, center(step.location)) > BUILD_REACH) {
      this.state.goal = "field";
      this.status("walking to work");
      return "wait";
    }

    if (!block.isAir && !step.keep?.(block.typeId)) {
      this.clear(block, plan);
      return "done";
    }
    if (!step.place) return "done";

    let item: string | undefined;
    if (step.material) {
      const taken = this.material(step.material, plan);
      if (taken === "wait") return "wait";
      item = taken;
    }
    if (step.solid && this.isOccupied(step.location)) {
      this.state.goal = "field";
      this.status("waiting - someone is in the way");
      return "wait";
    }

    try {
      for (const p of step.place(item)) {
        safeGetBlock(this.dimension, p.location)?.setPermutation(BlockPermutation.resolve(p.block, p.states));
      }
    } catch (error) {
      console.warn(`[Farmer] cannot place at ${JSON.stringify(step.location)}: ${error}`);
      this.state.cursor = this.state.cursor + 1; // skip it, the repair pass tries again later
      return "done";
    }
    if (item && step.material) this.consume(item, step.material, plan);

    this.state.goal = "none";
    face(this.entity, step.location);
    this.dimension.playSound("dig.gravel", step.location);
    this.status(`building ${this.progress(plan)}%`);
    return "done";
  }

  private progress(plan: FieldPlan): number {
    return Math.floor((100 * this.state.cursor) / plan.steps.length);
  }

  /** Returns the item to use for a step, fetching it from a chest if needed. */
  private material(material: Material, plan: FieldPlan): string | "wait" {
    if (material.source === "seeds") {
      const seed = Object.keys(this.state.bag).find((id) => material.items.includes(id));
      if (seed) return seed;
    }
    const carry = this.state.carry;
    const carried = material.items.find((id) => (carry[id]?.count ?? 0) > 0);
    if (carried) return carried;

    const source = plan.chests[material.source];
    if (Vector3Utils.distance(this.entity.location, center(source)) > CHEST_REACH) {
      this.state.goal = "chest";
      this.status(`fetching ${material.label}`);
      return "wait";
    }
    // Hands full: put everything back before taking something new.
    if (Object.keys(carry).length >= CARRY_KINDS) this.putBack(plan);

    const container = containerAt(this.dimension, source);
    if (!container) {
      this.status(`waiting for the ${material.source} chest`);
      return "wait";
    }
    for (let slot = 0; slot < container.size; slot++) {
      const stack = container.getItem(slot);
      if (!stack || !material.items.includes(stack.typeId)) continue;
      const count = Math.min(stack.amount, CARRY_MAX);
      if (stack.amount > count) {
        stack.amount -= count;
        container.setItem(slot, stack);
      } else {
        container.setItem(slot);
      }
      this.state.carry = { ...this.state.carry, [stack.typeId]: { count, source: material.source } };
      this.dimension.playSound("random.pop", source);
      return stack.typeId;
    }
    this.state.goal = "none";
    this.status(`needs ${material.label} in the ${material.source} chest`);
    return "wait";
  }

  private consume(item: string, material: Material, plan: FieldPlan): void {
    const bag = this.state.bag;
    if (material.source === "seeds" && (bag[item] ?? 0) > 0) {
      bag[item]--;
      this.state.bag = bag;
    } else {
      const carry = this.state.carry;
      carry[item].count--;
      this.state.carry = carry;
    }
    if (material.returns) this.store(new ItemStack(material.returns), plan.chests.input);
  }

  private putBack(plan: FieldPlan): void {
    for (const [id, { count, source }] of Object.entries(this.state.carry)) {
      this.store(new ItemStack(id, count), plan.chests[source]);
    }
    this.state.carry = {};
  }

  /** Brings unused building material back once the field is done. */
  private returnCarried(plan: FieldPlan): void {
    if (Vector3Utils.distance(this.entity.location, center(plan.chests.input)) > CHEST_REACH) {
      this.state.goal = "chest";
      this.status("bringing back unused material");
      return;
    }
    this.putBack(plan);
  }

  /** Puts items into the chest at `location`; drops what doesn't fit. */
  private store(stack: ItemStack, location: Vector3): void {
    const container = containerAt(this.dimension, location);
    const rest = container ? container.addItem(stack) : stack;
    if (rest) dropOn(this.dimension, location, rest);
  }

  /** Removes a block; its drops (and container contents) go into the leftovers chest. */
  private clear(block: Block, plan: FieldPlan): void {
    const items: ItemStack[] = [];
    if (!block.isLiquid) {
      const container = block.getComponent(BlockComponentTypes.Inventory)?.container;
      for (let slot = 0; container && slot < container.size; slot++) {
        const stack = container.getItem(slot);
        if (stack) items.push(stack);
      }
      container?.clearAll();
      try {
        items.push(...(world.getLootTableManager().generateLootFromBlock(block) ?? []));
      } catch {
        // some blocks have no loot table
      }
    }
    const location = block.location;
    block.setType(MinecraftBlockTypes.Air);
    for (const stack of items) this.store(stack, plan.chests.leftovers);
    face(this.entity, location);
    this.dimension.playSound("dig.stone", location);
    this.status(`clearing the field ${this.progress(plan)}%`);
  }

  private isOccupied(location: Vector3): boolean {
    return [location, up(location, -1)].some(
      (cell) =>
        this.dimension.getEntities({ location: center(cell), maxDistance: 0.9, excludeTypes: NON_BLOCKING_ENTITIES })
          .length > 0
    );
  }

  // --- farming ----------------------------------------------------------------------------------------

  private findMatureCrop(plan: FieldPlan, reach: number): Block | undefined {
    for (const soil of plan.farmland) {
      const location = up(soil);
      if (reach !== Infinity && Vector3Utils.distance(this.entity.location, center(location)) > reach) continue;
      const block = safeGetBlock(this.dimension, location);
      if (block && CROP_BLOCKS.has(block.typeId) && block.permutation.getState("growth") === MATURE_GROWTH) {
        return block;
      }
    }
    return undefined;
  }

  /** Harvests one mature crop using its vanilla loot table, then replants it with one of the drops. */
  private harvest(block: Block, bag: Bag): void {
    const crop = CROPS.find((c) => c.block === block.typeId)!;
    const location = block.location;
    for (const drop of world.getLootTableManager().generateLootFromBlock(block) ?? []) {
      bag[drop.typeId] = (bag[drop.typeId] ?? 0) + drop.amount;
    }
    if ((bag[crop.seed] ?? 0) > 0) {
      bag[crop.seed]--;
      block.setPermutation(BlockPermutation.resolve(crop.block, { growth: 0 }));
    } else {
      block.setType(MinecraftBlockTypes.Air); // replanted later with seeds from the seed chest
    }
    this.state.bag = bag;
    face(this.entity, location);
    this.dimension.spawnParticle("minecraft:crop_growth_emitter", center(location));
    this.dimension.playSound("dig.grass", location);
    this.status(`harvesting (${bagSize(bag)}/${BAG_CAPACITY})`);
  }

  /**
   * Vegetables go into their own chest (placed on demand). Leftovers and vegetables that don't fit go into the
   * compost chest; anything else into the leftovers chest. Returns "wait" while the farmer is on its way.
   */
  private unload(plan: FieldPlan, bag: Bag): Outcome {
    if (Vector3Utils.distance(this.entity.location, center(plan.chests.input)) > CHEST_REACH) {
      this.state.goal = "chest";
      this.status(`bringing ${bagSize(bag)} items to the chests`);
      return "wait";
    }

    const kept: Bag = {};
    const missingChests: string[] = [];
    for (const [id, count] of Object.entries(bag)) {
      let rest: ItemStack | undefined = new ItemStack(id, count);
      if (PRODUCE.has(id)) {
        const chest = this.cropChest(plan, id);
        if (!chest) {
          kept[id] = count;
          missingChests.push(prettyName(id));
          continue;
        }
        rest = chest.addItem(rest);
      }
      const target = COMPOSTABLE.has(id) ? plan.chests.compost : plan.chests.leftovers;
      if (rest) this.store(rest, target);
    }
    this.state.bag = kept;
    this.state.goal = "none";
    face(this.entity, plan.chests.input);
    this.dimension.playSound("random.chestclosed", plan.chests.input);
    if (missingChests.length > 0) {
      this.status(`needs a Chest (for ${missingChests.join(", ")})`);
    }
    return "done";
  }

  /** The chest for one vegetable; placed with a chest from the input chest the first time it is needed. */
  private cropChest(plan: FieldPlan, produce: string): Container | undefined {
    const location = plan.chests[`crop:${produce}`];
    const existing = safeGetBlock(this.dimension, location);
    if (existing?.typeId === MinecraftBlockTypes.Chest) return containerAt(this.dimension, location);

    const input = containerAt(this.dimension, plan.chests.input);
    const slot =
      input && [...Array(input.size).keys()].find((s) => input.getItem(s)?.typeId === MinecraftItemTypes.Chest);
    if (!input || slot === undefined || !existing) return undefined;
    const stack = input.getItem(slot)!;
    if (stack.amount > 1) {
      stack.amount--;
      input.setItem(slot, stack);
    } else {
      input.setItem(slot);
    }
    if (!existing.isAir) this.clear(existing, plan);
    existing.setPermutation(BlockPermutation.resolve(MinecraftBlockTypes.Chest));
    return containerAt(this.dimension, location);
  }

  // --- night ------------------------------------------------------------------------------------------

  private night(plan: FieldPlan): void {
    const head = safeGetBlock(this.dimension, plan.bed.head);
    if (!head || !isBedHead(head)) {
      if (this.state.sleeping) this.wakeUp(plan);
      this.state.goal = "none";
      this.status("no bed yet - resting");
      return;
    }
    if (this.state.sleeping) {
      this.status("Zzz...");
      return;
    }
    if (Vector3Utils.distance(this.entity.location, center(plan.bed.head)) > BED_REACH) {
      this.state.goal = "bed";
      this.status("going to bed");
      return;
    }
    this.state.goal = "none";
    this.state.sleeping = true;
    // Lie on the head piece, looking towards the foot of the bed.
    this.entity.teleport(
      { x: plan.bed.head.x + 0.5, y: plan.bed.head.y + BED_HEIGHT, z: plan.bed.head.z + 0.5 },
      { facingLocation: { x: plan.bed.foot.x + 0.5, y: plan.bed.foot.y + BED_HEIGHT, z: plan.bed.foot.z + 0.5 } }
    );
    this.status("Zzz...");
  }

  private wakeUp(plan: FieldPlan | undefined): void {
    this.state.sleeping = false;
    const spot = plan && spotNextToBed(this.dimension, plan.bed.head);
    if (spot) this.entity.teleport({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 });
    this.status("good morning!");
  }

  // --- info -------------------------------------------------------------------------------------------

  /** Chat lines describing the farmer: field state, bag and the materials still needed. */
  describe(): string[] {
    const ctx = this.context();
    if ("problem" in ctx) return [`Field: ${ctx.problem}`];
    const { plan } = ctx;
    const needed = new Map<string, number>();
    for (const step of plan.steps) {
      if (!step.material) continue;
      const block = safeGetBlock(this.dimension, step.location);
      if (!block || step.done(block.typeId) || block.typeId === FIELD_MARKER) continue;
      if (step.skipIf && step.skipIf.below(safeGetBlock(this.dimension, up(step.location, -1))?.typeId ?? "")) continue;
      needed.set(step.material.label, (needed.get(step.material.label) ?? 0) + 1);
    }
    for (const id of Object.keys(this.state.bag).filter((id) => PRODUCE.has(id))) {
      if (safeGetBlock(this.dimension, plan.chests[`crop:${id}`])?.typeId !== MinecraftBlockTypes.Chest) {
        needed.set(`Chest (for ${prettyName(id)})`, 1);
      }
    }
    const bag = Object.entries(this.state.bag).map(([id, n]) => `${n}x ${prettyName(id)}`);
    const carry = Object.entries(this.state.carry).map(([id, c]) => `${c.count}x ${prettyName(id)}`);
    return [
      `Field: ${plan.interior.length} blocks inside, ${plan.farmland.length} farmland`,
      needed.size > 0
        ? `Still needed: ${[...needed].map(([label, n]) => `§e${n}x §f${label}`).join("§7, §f")}`
        : "Field is complete.",
      `Carrying: ${[...bag, ...carry].join(", ") || "nothing"}`,
    ];
  }

  /** The input chest of this farmer's field, if any. */
  inputChest(): Vector3 | undefined {
    const ctx = this.context();
    return "plan" in ctx ? ctx.plan.chests.input : undefined;
  }

  private status(text: string): void {
    setStatus(this.entity, "Farmer", text);
  }
}
