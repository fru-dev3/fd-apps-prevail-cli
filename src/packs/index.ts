// Bundled role packs, statically imported so `bun build --compile` embeds them
// into the sidecar binary (a runtime fs read of src/packs would not survive
// compilation). Add a new persona by dropping a JSON file here and importing it.

import type { PrevailPack } from "../pack.ts";

import creator from "./creator.json";
import family from "./family.json";
import freelancer from "./freelancer.json";
import highIncome from "./high-income.json";
import smallBusinessOwner from "./small-business-owner.json";
import student from "./student.json";

export const BUNDLED_PACKS: { file: string; pack: PrevailPack }[] = [
  { file: "small-business-owner.json", pack: smallBusinessOwner as PrevailPack },
  { file: "family.json", pack: family as PrevailPack },
  { file: "student.json", pack: student as PrevailPack },
  { file: "high-income.json", pack: highIncome as PrevailPack },
  { file: "freelancer.json", pack: freelancer as PrevailPack },
  { file: "creator.json", pack: creator as PrevailPack },
];
