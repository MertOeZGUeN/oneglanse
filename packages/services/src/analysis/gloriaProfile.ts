import type { VisibilityTrackedEntity } from "@oneglanse/types";

export const GLORIA_BRAND_ALIASES = [
	"Gloria Hotels & Resorts",
	"Gloria Hotels and Resorts",
	"Gloria Hotels",
	"Gloria Resorts",
	"Gloria",
];

export const GLORIA_PROPERTIES: VisibilityTrackedEntity[] = [
	{
		name: "Gloria Serenity Resort",
		aliases: ["Gloria Serenity", "Gloria Serenity Resort Belek"],
	},
	{
		name: "Gloria Golf Resort",
		aliases: ["Gloria Golf Resort Belek"],
	},
	{
		name: "Gloria Verde Resort",
		aliases: ["Gloria Verde", "Gloria Verde Resort Belek"],
	},
	{
		name: "Gloria Sports Arena",
		aliases: ["Gloria Sports Arena Belek"],
	},
	{
		name: "Gloria Golf Club",
		aliases: ["Gloria Golf Club Belek"],
	},
];

export const GLORIA_COMPETITORS: VisibilityTrackedEntity[] = [
	{ name: "Maxx Royal Belek", aliases: ["Maxx Royal"] },
	{ name: "Regnum Carya" },
	{ name: "Regnum The Crown", aliases: ["The Crown by Regnum"] },
	{ name: "NG Phaselis Bay", aliases: ["NG Phaselis"] },
	{ name: "Cullinan Belek", aliases: ["Cullinan"] },
	{ name: "Rixos Premium Belek", aliases: ["Rixos Premium"] },
	{ name: "Ethno Belek", aliases: ["Ethno"] },
];

export function isGloriaWorkspace(domain: string): boolean {
	return /(^|\.)gloria\.com\.tr$/i.test(domain.replace(/^https?:\/\//i, "").split("/")[0] ?? "");
}
