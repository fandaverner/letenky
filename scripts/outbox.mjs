// Odešle upozornění odložená během hledání (až po aktualizaci webu).
import { readFile, rm } from "node:fs/promises";
import { flushOutbox } from "./notify.mjs";
const r = await flushOutbox();
console.log("Odeslaná upozornění:", JSON.stringify(r));
