import {
  BlockComponentTypes,
  BlockPermutation,
  type Container,
  type Dimension,
  type Entity,
  ItemStack,
  type Vector3,
} from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { MinecraftBlockTypes, MinecraftEntityTypes } from "@minecraft/vanilla-data";
import { BLUEPRINT, type BlueprintStep, HOUSE_OFFSET_FROM_BARREL } from "./blueprint";
import {
  center,
  dropOn,
  face,
  findBlockNear,
  isReplaceable,
  placeBlockNextTo,
  prettyName,
  safeGetBlock,
  setStatus,
} from "./common";

export const BUILDER_TYPE = "mob:builder";

/** How close (blocks) the builder must be to the barrel to take an item out of it. */
const BARREL_REACH = 3;
/** How close (blocks) the builder must be to a target block to place it. */
const BUILD_REACH = 12;
/** Radius searched for an existing barrel when a builder is first seen. */
const BARREL_SEARCH_RADIUS = 4;

const Prop = {
  barrel: "mob:barrel",
  step: "mob:step",
  carrying: "mob:carrying",
  fetching: "mob:fetching",
  finished: "mob:finished",
} as const;

const WOODEN_BLOCKS = new Set<string>([MinecraftBlockTypes.OakPlanks, MinecraftBlockTypes.OakLog]);

/** Entities that do not prevent a block from being placed. */
const NON_BLOCKING_ENTITIES = ["minecraft:item", MinecraftEntityTypes.XpOrb];

/** A builder's persistent state, stored as dynamic properties on the entity itself. */
class BuilderState {
  constructor(private readonly entity: Entity) {}

  get barrel(): Vector3 | undefined {
    return this.entity.getDynamicProperty(Prop.barrel) as Vector3 | undefined;
  }
  set barrel(value: Vector3 | undefined) {
    this.entity.setDynamicProperty(Prop.barrel, value);
  }

  get step(): number {
    return (this.entity.getDynamicProperty(Prop.step) as number | undefined) ?? 0;
  }
  set step(value: number) {
    this.entity.setDynamicProperty(Prop.step, value);
  }

  get carrying(): string | undefined {
    return this.entity.getDynamicProperty(Prop.carrying) as string | undefined;
  }
  set carrying(value: string | undefined) {
    this.entity.setDynamicProperty(Prop.carrying, value);
  }

  get fetching(): boolean {
    return this.entity.getDynamicProperty(Prop.fetching) === true;
  }
  set fetching(value: boolean) {
    if (value === this.fetching) return;
    this.entity.setDynamicProperty(Prop.fetching, value);
    // Toggles the data-driven "walk to the nearest barrel" goal defined in entities/builder.json.
    this.entity.triggerEvent(value ? "mob:start_fetching" : "mob:stop_fetching");
  }

  get finished(): boolean {
    return this.entity.getDynamicProperty(Prop.finished) === true;
  }
  set finished(value: boolean) {
    this.entity.setDynamicProperty(Prop.finished, value);
  }
}

export class Builder {
  private readonly state: BuilderState;

  constructor(private readonly entity: Entity) {
    this.state = new BuilderState(entity);
  }

  private get dimension(): Dimension {
    return this.entity.dimension;
  }

  /** Called periodically: performs at most one action (link barrel, fetch one block, or place one block). */
  tick(): void {
    if (this.state.finished) return;

    const barrelLocation = this.state.barrel ?? this.linkBarrel();
    if (!barrelLocation) {
      this.status("needs space for a barrel");
      return;
    }

    const barrel = safeGetBlock(this.dimension, barrelLocation);
    if (!barrel) return; // chunk not loaded, try again later
    const container = barrel.getComponent(BlockComponentTypes.Inventory)?.container;
    if (barrel.typeId !== MinecraftBlockTypes.Barrel || !container) {
      this.status("lost its barrel!");
      return;
    }

    const next = this.nextStep(barrelLocation);
    if (!next) {
      this.finish(barrelLocation, container);
      return;
    }

    const carrying = this.state.carrying;
    if (carrying === undefined) {
      this.fetch(barrelLocation, container, next.step.block);
    } else if (carrying !== next.step.block) {
      // The plan changed under us (e.g. a player placed that block). Put the item back.
      this.returnItem(carrying, barrelLocation, container);
    } else {
      this.place(next.location, next.step);
    }
  }

  /** Materials still required to finish the house, keyed by block id. */
  remainingMaterials(): Map<string, number> {
    const remaining = new Map<string, number>();
    const barrel = this.state.barrel;
    if (!barrel) return remaining;
    const carrying = this.state.carrying;
    let carriedCounted = false;
    for (const step of BLUEPRINT.slice(this.state.step)) {
      if (!carriedCounted && step.block === carrying) {
        carriedCounted = true; // already in the builder's hands
        continue;
      }
      remaining.set(step.block, (remaining.get(step.block) ?? 0) + 1);
    }
    return remaining;
  }

  get barrelLocation(): Vector3 | undefined {
    return this.state.barrel;
  }

  get progress(): { done: number; total: number } {
    return { done: Math.min(this.state.step, BLUEPRINT.length), total: BLUEPRINT.length };
  }

  /** Finds a barrel next to the builder, or places a new one, and remembers it as the input barrel. */
  private linkBarrel(): Vector3 | undefined {
    const barrel =
      findBlockNear(this.dimension, this.entity.location, BARREL_SEARCH_RADIUS, MinecraftBlockTypes.Barrel) ??
      placeBlockNextTo(
        this.dimension,
        this.entity.location,
        BlockPermutation.resolve(MinecraftBlockTypes.Barrel, { facing_direction: 1 })
      );
    if (barrel) {
      this.state.barrel = barrel;
      this.state.step = 0;
      this.status("ready - fill the barrel!");
    }
    return barrel;
  }

  /** Skips steps that are already built or blocked, and returns the next step that needs a block. */
  private nextStep(barrel: Vector3): { step: BlueprintStep; location: Vector3 } | undefined {
    const houseOrigin = Vector3Utils.add(barrel, HOUSE_OFFSET_FROM_BARREL);
    let index = this.state.step;
    try {
      for (; index < BLUEPRINT.length; index++) {
        const step = BLUEPRINT[index];
        const location = Vector3Utils.add(houseOrigin, step.offset);
        const block = safeGetBlock(this.dimension, location);
        if (!block) return undefined; // not loaded yet
        if (block.typeId === step.block) continue; // already there
        if (!isReplaceable(block)) continue; // something else is in the way - never destroy player builds
        return { step, location };
      }
      return undefined;
    } finally {
      if (index !== this.state.step) this.state.step = index;
    }
  }

  private fetch(barrel: Vector3, container: Container, blockId: string): void {
    if (Vector3Utils.distance(this.entity.location, center(barrel)) > BARREL_REACH) {
      this.state.fetching = true;
      this.status(`walking to the barrel for ${prettyName(blockId)}`);
      return;
    }

    for (let slot = 0; slot < container.size; slot++) {
      const item = container.getItem(slot);
      if (item?.typeId !== blockId) continue;
      if (item.amount > 1) {
        item.amount--;
        container.setItem(slot, item);
      } else {
        container.setItem(slot);
      }
      this.state.carrying = blockId;
      this.state.fetching = false;
      this.dimension.playSound("random.pop", barrel);
      this.status(`carrying ${prettyName(blockId)}`);
      return;
    }

    // Stay close to the barrel while waiting for the player.
    this.state.fetching = true;
    this.status(`needs ${prettyName(blockId)}`);
  }

  private place(location: Vector3, step: BlueprintStep): void {
    if (Vector3Utils.distance(this.entity.location, center(location)) > BUILD_REACH) {
      this.status(`too far away to place ${prettyName(step.block)}`);
      return;
    }
    if (this.isOccupied(location)) {
      this.status("waiting - someone is in the way");
      return;
    }

    this.dimension.setBlockType(location, step.block);
    this.dimension.spawnParticle("minecraft:villager_happy", center(location));
    this.dimension.playSound(WOODEN_BLOCKS.has(step.block) ? "dig.wood" : "dig.stone", location);
    face(this.entity, location);
    this.state.carrying = undefined;
    this.state.step = this.state.step + 1;
    this.status(`built ${this.progress.done}/${this.progress.total}`);
  }

  private isOccupied(location: Vector3): boolean {
    // An entity blocks the cell if its feet are in it or in the cell below (head reaches into it).
    return [location, Vector3Utils.add(location, { x: 0, y: -1, z: 0 })].some(
      (cell) =>
        this.dimension.getEntities({
          location: center(cell),
          maxDistance: 0.9,
          excludeTypes: NON_BLOCKING_ENTITIES,
        }).length > 0
    );
  }

  private returnItem(itemId: string, barrel: Vector3, container: Container): void {
    const leftover = container.addItem(new ItemStack(itemId));
    if (leftover) dropOn(this.dimension, barrel, leftover);
    this.state.carrying = undefined;
  }

  private finish(barrel: Vector3, container: Container): void {
    const carrying = this.state.carrying;
    if (carrying) this.returnItem(carrying, barrel, container);
    this.state.fetching = false;
    this.state.finished = true;
    this.dimension.spawnParticle("minecraft:totem_particle", center(this.entity.location));
    this.dimension.playSound("random.levelup", this.entity.location);
    this.status("house finished!");
  }

  private status(text: string): void {
    setStatus(this.entity, "Builder", text);
  }
}
