export type { ProfilePlugin, ProfileInfo } from "../types";
export { invoiceProfile, invoicePlugin } from "./invoice";
export { receiptProfile, receiptPlugin } from "./receipt";
export { resumeProfile, resumePlugin } from "./resume";
export { contractProfile, contractPlugin } from "./contract";
export { fallbackProfile, fallbackPlugin } from "./fallback";
export { ProfileManager, getProfileManager } from "./registry";
