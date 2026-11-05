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

1. Spawn a Farmer with the **Spawn Farmer** egg, or run `/summon mob:farmer`, next to your field.
2. The Farmer looks for a chest within 4 blocks. If it doesn't find one, it places a new chest next to itself.
   That chest is its collector chest. It also uses a composter within 4 blocks of the chest, or places one next
   to the chest.
3. The Farmer works the farmland **you** made within 8 blocks of the chest. It supports wheat, carrots, potatoes
   and beetroot.
4. When a crop is fully grown, the Farmer harvests it. The drops come from the block's vanilla loot table
   (`LootTableManager.generateLootFromBlock`). It keeps one seed, carrot or potato from that harvest and
   replants the same crop right away.
5. When it carries 16 items, or there is nothing left to harvest, it walks to the chest and unloads:
   - **Vegetables** (wheat, carrots, potatoes, beetroot) go into the chest.
   - **Leftovers** (surplus seeds and anything else that isn't a vegetable), plus any vegetables that don't fit
     in a full chest, go into the composter.
   - When the composter is full, any further items are dropped next to it.
6. A ready composter is emptied by the Farmer: the bone meal goes into the chest, or is dropped if the chest
   is full.

Right-click the Farmer to see in chat what it is carrying.

> **Compost chances** are 30% for seeds and 65% for wheat, carrots, potatoes and beetroot. They are recalled
> from vanilla behaviour and **not verified** against official documentation. Change them in `COMPOST_CHANCE`
> in `scripts/farmer.ts`. Items without an entry in that table, such as poisonous potatoes, are not composted.
> They are dropped next to the composter.

## Project layout

```
behavior_packs/mob_builder/
  manifest.json            # depends on @minecraft/server 2.11.0 (stable)
  entities/builder.json    # entity: movement, home radius, "walk to barrel" goal (component group)
  entities/farmer.json     # entity: "walk to crops" / "walk to chest" goals (component groups)
resource_packs/mob_builder/
  entity/*.entity.json     # vanilla villager_v2 model; stonemason (Builder) / farmer (Farmer) outfit
  render_controllers/worker.render_controllers.json  # villager skin + profession overlay
  texts/en_US.lang
scripts/
  main.ts       # main loop (one action per second per worker) + chat status
  common.ts     # shared helpers: find/place blocks, name tag status, drops
  builder.ts    # Builder AI: link barrel, fetch one block, place it
  blueprint.ts  # the house, drawn as ASCII layers. Edit this to build something else
  farmer.ts     # Farmer AI: link chest + composter, harvest/replant, unload
```

### How the pieces work together

- **Movement is data-driven.** The stable Script API has no pathfinding control, so the script switches
  `minecraft:behavior.move_to_block` goals on and off with entity events:
  - The Builder uses `mob:start_fetching` to walk to its barrel.
  - The Farmer uses `mob:go_to_crops` to walk among the crops, and `mob:go_to_chest` to walk to the chest.
  - Otherwise the workers stroll inside their `minecraft:home` radius, which keeps them near their work.
- **State is saved on the entity.** Linked block positions, build step, carried items and the Farmer's bag are
  stored as entity dynamic properties, so they survive world reloads.
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
- The Farmer doesn't till soil or plant on empty farmland. It only harvests and replants crops that are
  already growing.
- If a fully grown wheat or beetroot drops no seed and the Farmer has none in its bag, that spot stays empty.
- The script fills the composter itself (there is no stable API for a mob to use an item on a block). It also
  skips the short vanilla delay between "full" and "ready".
