import { batteryCore, batteryDots, batteryFill, batteryGauge, batteryRing } from "./battery";
import { networkSpeed } from "./network";
import { cpuRing, ramRing } from "./rings";
import { storageSpace } from "./storage";
import { topCpu, topRam } from "./top";

/** Hardware widgets (category "system"). CPU temperature is left out: Windows has no public API for it without a driver. */
export default [cpuRing, ramRing, batteryFill, batteryRing, batteryCore, batteryDots, batteryGauge, networkSpeed, storageSpace, topCpu, topRam];
