import { batteryCore, batteryDots, batteryFill, batteryGauge, batteryLiquid, batteryRing } from "./battery";
import { networkSpeed } from "./network";
import { cpuRing, ramRing } from "./rings";
import { storageSpace } from "./storage";
import { gpuTemperature, temperature } from "./temperature";
import { topCpu, topRam } from "./top";

/**
 * Hardware widgets (category "system"). A CPU core temperature is left out: Windows has no public
 * API for it without a driver; "Temperatura" uses the GPU (D3DKMT) and the ACPI thermal zones.
 */
export default [cpuRing, ramRing, batteryFill, batteryRing, batteryLiquid, batteryCore, batteryDots, batteryGauge, networkSpeed, storageSpace, topCpu, topRam, temperature, gpuTemperature];
