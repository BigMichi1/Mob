# Mob Builder: a Minecraft Bedrock add-on

A sample add-on with two villager-like worker mobs:

- **Builder**: builds a small house one block at a time, using the blocks a player puts into its **input barrel**.
- **Farmer**: harvests and replants crops, puts the vegetables into a **collector chest**, and puts leftovers
  into a **composter**.

It uses **only the stable Script API** (`@minecraft/server` 2.11.0). The world does **not** need the
*Beta APIs* experiment or any other experimental toggle.

## Builder

1. Spawn a Builder with the **Spawn Builder** egg (search for "Builder" in the Creative inventory), or run
   `/summon mob:builder`.
2. The Builder looks for a barrel within 4 blocks. If it doesn't find one, it places a new barrel next to itself.
   That barrel is its input barrel.
3. Put building blocks into the barrel. **Right-click the Builder** or **open the barrel** to see in chat what it
   still needs.
4. The Builder walks to the barrel, takes **one** block out, places it in the house, and repeats until the house
   is done.

The house is a 5×5 cottage that starts 2 blocks east of the barrel. Its door opening faces the barrel. To build
it you need:

| Block        | Amount |
|--------------|-------:|
| Oak Planks   | 56     |
| Cobblestone  | 25     |
| Oak Log      | 12     |
| Glass        | 3      |

The Builder never destroys blocks. If a solid block is in the way, it skips that spot. If a player places the
correct block first, the Builder counts that spot as done.

## Farmer

The Farmer builds and runs a complete farm in an area you mark.

### 1. Mark the field

Place **Field Markers** (new block: search for "Field Marker" in the Creative inventory, or craft 4 from
1 yellow dye above 1 stick) on the ground at the corners of your field:

- At least **3 markers**. The order you place them in is the outline (the last one connects back to the first),
  so any shape works, including L or U shapes.
- Markers belong to the player who placed them. A marker within 32 blocks of one of your fields joins that
  field. A marker farther away starts a new one.
- Breaking a marker removes it from the field, and the Farmer re-plans.

### 2. Spawn a Farmer

Spawn it with the **Spawn Farmer** egg (or `/summon mob:farmer`) within 16 blocks of a marker. It claims the
field (one Farmer per field) and places an **input chest** just inside the gate, for free.

### 3. Deliver materials into the input chest

Right-click the Farmer or open the input chest to see in chat what is still needed. For example, a 21×21
L-shaped field needs at most:

| Material                     | Used for                                                      |
|------------------------------|---------------------------------------------------------------|
| Chest (×4, +1 per vegetable) | leftovers, seeds, compost and bone meal chests, one chest per vegetable |
| Dirt                         | only for holes and for blocks that aren't dirt or grass       |
| Any wooden fence             | the outline, plus a lamp post next to each water spot         |
| Any wooden fence gate (×1)   | the entrance                                                  |
| Torch                        | every 4th fence post and every lamp post                      |
| Hopper (×2), Composter (×1)  | the compost station                                           |
| Bed (×1)                     | the Farmer's bed                                              |
| Water Bucket                 | one per water spot (about one every 9×9 blocks); the empty bucket goes back into the input chest |

Then put **seeds** (wheat seeds, carrots, potatoes, beetroot seeds) into the **seed chest**. The Farmer plants
whatever is in there.

### 4. What the Farmer builds

1. It **levels** the field to the markers' height: everything up to 3 blocks above the field is removed, and
   blocks at field level that aren't dirt or grass are replaced with dirt. The drops of removed blocks
   (including the contents of chests in the way) go into the **leftovers chest**, or are dropped when it is
   full. Field Markers are never removed.
2. A **fence** along the outline, with a **gate** on the first side (between marker 1 and 2), and torches.
3. Next to the gate:
   - the chests
   - a **compost station**: compost chest → hopper → composter → hopper → bone meal chest
   - the **bed**
4. **Water** spots so that all farmland is hydrated, each with a lamp post.
5. It **tills** the rest into farmland (no hoe needed) and **plants** it.

```
X#########G#########X     X  Field Marker      G  gate        #  fence
#,,,,,,cHR,I,c,,,,~##     I  input chest       R  leftovers   S  seed chest
#,,,,,,,KbS,c,,,,,,,#     c  vegetable chest   H  compost chest (on a hopper)
#,,,,,,,MB,c,,,,,,,,#     K  composter (hopper below)        M  bone meal chest
#,,,~#,,,,,,,~#,,,,,#     Bb bed               ~  water        ,  farmland
```

### 5. Farming

- Fully grown wheat, carrots, potatoes and beetroot are harvested. The drops come from the vanilla loot tables,
  and the crop is replanted with one of its own seeds. Empty farmland is replanted from the seed chest.
- **Vegetables** go into their own chest, **one chest per vegetable**. The first time a vegetable needs storing,
  that chest is placed, using a chest from the input chest.
- **Leftovers** (surplus seeds) and vegetables that don't fit go into the **compost chest**. Vanilla hoppers
  feed the composter, and the bone meal ends up in the **bone meal chest**. Anything else (e.g. poisonous
  potatoes) goes into the leftovers chest.
- Every 30 seconds of idle time it checks the whole field again. It repairs broken fences or torches and
  replants empty farmland.

### Sleeping

At night (game time 12542–23460, the same window in which players can sleep) the Farmer walks to its bed,
lies down (vanilla `animation.villager.get_in_bed`, driven by the `mob:sleeping` entity property) and gets up in
the morning. Until the bed is built, it just rests.

## Project layout

```
behavior_packs/mob_builder/
  manifest.json            # depends on @minecraft/server 2.11.0 (stable)
  entities/builder.json    # entity: movement, home radius, "walk to barrel" goal (component group)
  entities/farmer.json     # entity: walk to crops / chest / bed / field goals, "asleep" group, mob:sleeping property
  blocks/field_marker.json # the Field Marker block
  recipes/field_marker.json
resource_packs/mob_builder/
  entity/*.entity.json     # vanilla villager_v2 model; stonemason (Builder) / farmer (Farmer) outfit
  render_controllers/worker.render_controllers.json  # villager skin + profession overlay
  textures/blocks/mob_field_marker.png, terrain_texture.json, blocks.json  # Field Marker look
  texts/en_US.lang
scripts/
  main.ts       # main loop (one action per second per worker) + chat status
  common.ts     # shared helpers: find/place blocks, name tag status, drops
  builder.ts    # Builder AI: link barrel, fetch one block, place it
  blueprint.ts  # the house, drawn as ASCII layers. Edit this to build something else
  farmer.ts     # Farmer AI: build the plan, fetch materials, harvest/replant, unload, day/night routine
  fields.ts     # field registry (world dynamic property), marker grouping, claiming
  field-plan.ts # pure planner: markers -> outline, layout and ordered build steps
  bed.ts        # bed helpers
```

### How the pieces work together

- **Movement is data-driven.** The stable Script API has no pathfinding control, so the script switches
  `minecraft:behavior.move_to_block` goals on and off with entity events:
  - The Builder uses `mob:start_fetching` to walk to its barrel.
  - The Farmer uses `mob:go_to_crops`, `mob:go_to_chest`, `mob:go_to_bed` and `mob:go_to_field` (walks
    between the markers), plus `mob:fall_asleep` and `mob:wake_up` to freeze and unfreeze itself in bed.
  - Otherwise the workers stroll inside their `minecraft:home` radius, which keeps them near their work.
- **State is saved.** Fields (markers, owner, Farmer) are stored in a world dynamic property. Each worker's
  progress, carried items and bag are stored as entity dynamic properties. Everything survives world reloads.
  A field's build plan is computed from its markers and cached in memory.
- **One block at a time.** Each action takes exactly one item out of the barrel (`Container.getItem`/`setItem`).
  The next action places it with `Dimension.setBlockType`.

### Changing the house

Edit `LAYERS` and `LEGEND` in `scripts/blueprint.ts`. Each layer is a list of rows along +z. Each character in a
row is one block along +x, and `.` means air. Use only blocks whose item id equals the block id (planks, logs,
stone, glass, wool, …). Blocks that need two halves or a placement direction, like doors and stairs, are not
handled by this sample.

## Build

This project uses Mojang's official toolchain [`@minecraft/core-build-tasks`](https://www.npmjs.com/package/@minecraft/core-build-tasks)
(the same setup as the `ts-starter` sample).

```bash
npm install
npm run build        # type-check + bundle to dist/scripts/main.js
npm run lint         # eslint + prettier
npm run mcaddon      # dist/packages/mob_builder.mcaddon. Double-click it to import into Minecraft
npm run local-deploy # Windows: watch + copy into the game's development_*_packs folders
```

`MINECRAFT_PRODUCT` in `.env` selects the deploy target for `local-deploy`. The value `BedrockGDK` is for the
current Windows release.

## Requirements

- Minecraft Bedrock **1.26.60** or newer (`min_engine_version`, and the version that ships `@minecraft/server` 2.11.0
  as stable)
- Node.js 20+

## Known limitations

- The Builder places blocks from up to 12 blocks away, because stable scripting cannot steer the mob to a
  specific spot.
- The Farmer works within 12 blocks of where it stands, so on large fields it walks between the markers to
  reach everything.
- Fields need at least 20 blocks inside the markers, and one straight piece of outline for the gate.
- **Needs checking in game:**
  - The bed placement assumes the bed `direction` state means 0 = south, 1 = west, 2 = north, 3 = east (the
    direction the head points from the foot). If beds come out broken or as single halves, adjust
    `BED_DIRECTIONS` in `scripts/field-plan.ts`.
  - Which end of the bed the Farmer's head ends up at depends on how the vanilla sleep animation is oriented.
  - The fence connection states are set explicitly. Check that the game doesn't override them.
- A placed bed has the default colour (scripts can't set a bed's colour).
