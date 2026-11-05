# Mob Builder: a Minecraft Bedrock add-on

A sample add-on with a villager-like **Builder** mob. The Builder builds a small house one block at a time,
using the blocks a player puts into its **input barrel**.

It uses **only the stable Script API** (`@minecraft/server` 2.11.0). The world does **not** need the
*Beta APIs* experiment or any other experimental toggle.

## How it plays

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

## Project layout

```
behavior_packs/mob_builder/
  manifest.json            # depends on @minecraft/server 2.11.0 (stable)
  entities/builder.json    # entity: movement, home radius, "walk to barrel" goal (component group)
resource_packs/mob_builder/
  entity/builder.entity.json  # reuses the vanilla villager_v2 model + wandering trader texture
  texts/en_US.lang
scripts/
  main.ts       # main loop (one action per second per Builder) + chat status
  builder.ts    # Builder AI: link barrel, fetch one block, place it; state kept in dynamic properties
  blueprint.ts  # the house, drawn as ASCII layers. Edit this to build something else
```

### How the pieces work together

- **Movement is data-driven.** The stable Script API has no pathfinding control. When the Builder needs to
  fetch something, the script triggers `mob:start_fetching`. That event adds a `minecraft:behavior.move_to_block`
  goal targeting `minecraft:barrel`. Otherwise the Builder strolls inside its `minecraft:home` radius (8 blocks),
  which keeps it next to the barrel and the building site.
- **State is saved on the entity.** The barrel position, build step, carried block and finished flag are stored
  as entity dynamic properties, so they survive world reloads.
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
- The vanilla wandering trader model and texture are used as placeholders. To give the Builder its own look,
  replace `textures`/`geometry` in `resource_packs/mob_builder/entity/builder.entity.json`.
