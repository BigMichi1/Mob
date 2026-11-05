import minecraftLinting from "eslint-plugin-minecraft-linting";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["scripts/**/*.ts"],
  extends: [tseslint.configs.recommended],
  plugins: { "minecraft-linting": minecraftLinting },
  rules: {
    "minecraft-linting/avoid-unnecessary-command": "error",
  },
});
