import { Pressable, View } from "@tarve/core";
import { tapKey, VK } from "../../native/win32";
import { ui } from "../../theme";
import { WindowsLogo } from "../ui";
import { defineWidget } from "../types";

export default defineWidget({
  type: "start",
  name: "Iniciar",
  description: "Abre o menu Iniciar do Windows.",
  category: "apps",
  defaultConfig: {},
  setup: () => ({}),
  View() {
    // Same slot and icon size as the app icons, so it lines up with them.
    return (
      <Pressable
        onClick={() => tapKey(VK.LWIN)}
        style={{
          width: ui.app.slot,
          height: ui.tile.height,
          radius: 10,
          align: "center",
          justify: "center",
          cursor: "pointer",
          shrink: 0,
          hover: { background: "rgba(255,255,255,0.06)" },
          active: { transform: "scale(0.9)" },
        }}
      >
        <View
          style={{
            width: ui.app.icon,
            height: ui.app.icon,
            radius: 8,
            align: "center",
            justify: "center",
            background: "linear-gradient(160deg, #3a3a40, #1b1b1f)",
          }}
        >
          <WindowsLogo size={15} />
        </View>
      </Pressable>
    );
  },
});
