import { type Entity, type Vector3, world } from "@minecraft/server";
import { Vector3Utils } from "@minecraft/math";
import { FIELD_MARKER, type FieldPlan, planField, type PlanResult } from "./field-plan";

/** A field as marked by a player: markers in placement order. Stored in a world dynamic property. */
export interface Field {
  readonly id: string;
  readonly owner: string;
  readonly dimension: string;
  markers: Vector3[];
  /** Incremented on every change, so farmers know when to re-plan. */
  version: number;
  /** Entity id of the farmer working this field. */
  farmer?: string;
}

const STORAGE_KEY = "mob:fields";
/** A new marker joins a field of the same player when it is this close to one of its markers. */
const JOIN_DISTANCE = 32;
/** A farmer claims a free field when it is inside it or this close to one of its markers. */
const CLAIM_DISTANCE = 16;

let cache: Field[] | undefined;

function fields(): Field[] {
  cache ??= JSON.parse((world.getDynamicProperty(STORAGE_KEY) as string | undefined) ?? "[]") as Field[];
  return cache;
}

function save(): void {
  world.setDynamicProperty(STORAGE_KEY, JSON.stringify(fields()));
}

const nearestMarkerDistance = (field: Field, location: Vector3): number =>
  Math.min(...field.markers.map((m) => Vector3Utils.distance(m, location)));

export function getField(id: string | undefined): Field | undefined {
  return id === undefined ? undefined : fields().find((f) => f.id === id);
}

/** Adds a marker to the owner's nearest field (or starts a new one) and returns that field's marker count. */
export function markerPlaced(owner: string, dimension: string, location: Vector3): number {
  const field = fields()
    .filter((f) => f.owner === owner && f.dimension === dimension)
    .map((f) => ({ f, d: nearestMarkerDistance(f, location) }))
    .filter(({ d }) => d <= JOIN_DISTANCE)
    .sort((a, b) => a.d - b.d)[0]?.f;
  const target = field ?? {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    owner,
    dimension,
    markers: [],
    version: 0,
  };
  if (!field) fields().push(target);
  target.markers.push({ x: location.x, y: location.y, z: location.z });
  target.version++;
  save();
  return target.markers.length;
}

export function markerRemoved(dimension: string, location: Vector3): void {
  const all = fields();
  const field = all.find((f) => f.dimension === dimension && f.markers.some((m) => Vector3Utils.equals(m, location)));
  if (!field) return;
  field.markers = field.markers.filter((m) => !Vector3Utils.equals(m, location));
  field.version++;
  if (field.markers.length === 0) all.splice(all.indexOf(field), 1);
  save();
}

/** Returns the field this farmer works, claiming a free one nearby if it has none. */
export function fieldFor(farmer: Entity, knownId: string | undefined): Field | undefined {
  const known = getField(knownId);
  if (known && known.farmer === farmer.id) return known;

  const isFree = (f: Field) => f.farmer === undefined || f.farmer === farmer.id || !world.getEntity(f.farmer);
  const candidate = fields()
    .filter((f) => f.dimension === farmer.dimension.id && f.markers.length >= 3 && isFree(f))
    .map((f) => ({ f, d: nearestMarkerDistance(f, farmer.location) }))
    .filter(({ d }) => d <= CLAIM_DISTANCE)
    .sort((a, b) => a.d - b.d)[0]?.f;
  if (!candidate) return undefined;
  candidate.farmer = farmer.id;
  save();
  return candidate;
}

export function releaseField(farmerId: string): void {
  const field = fields().find((f) => f.farmer === farmerId);
  if (!field) return;
  field.farmer = undefined;
  save();
}

/** Plans are derived from the markers, so they are cached in memory per field version. */
const plans = new Map<string, { version: number; result: PlanResult }>();

export function planFor(field: Field): PlanResult {
  const cached = plans.get(field.id);
  if (cached?.version === field.version) return cached.result;
  const result = planField(field.markers);
  plans.set(field.id, { version: field.version, result });
  return result;
}

export type { FieldPlan };
export { FIELD_MARKER };
