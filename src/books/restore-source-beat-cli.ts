import fs from "node:fs/promises";
import path from "node:path";
import {dataDir, loadDotEnv} from "../util/env.js";
import {getBook, saveBook} from "./repository.js";
import {restoreSourceBeat} from "./source-index/restore-beat.js";
loadDotEnv();
const args = process.argv.slice(2), values = new Map<string,string>();
let apply = false;
for (let i=0; i<args.length; i++) {
  const arg=args[i]!;
  if (arg === "--apply") {apply=true;continue;}
  if (!["--book","--event","--source"].includes(arg) || !args[i+1] || args[i+1]!.startsWith("--") || values.has(arg)) throw new Error("Use --book ID --event SEQUENCE --source CHAPTER:EVENT:BEAT [--apply]; source indexes are zero-based");
  values.set(arg,args[++i]!);
}
const sequence=Number(values.get("--event")), source=values.get("--source")?.split(":").map(Number);
if (!values.get("--book") || !Number.isInteger(sequence) || sequence<1 || source?.length!==3 || source.some(i=>!Number.isInteger(i)||i<0)) throw new Error("Missing or invalid book, event or source indexes");
const original=await getBook(values.get("--book")!);
if (!original) throw new Error("Book not found");
const restored=restoreSourceBeat(original,sequence,source as [number,number,number]);
const beat=restored.storyEvents!.find(e=>e.sequence===sequence)!.beats!.at(-1)!;
console.log(JSON.stringify({applied:false,event:sequence,source,action:beat.action,resultingState:beat.resultingState},null,2));
if (apply) {
  const current=await getBook(original.bookId);
  if (JSON.stringify(current)!==JSON.stringify(original)) throw new Error("Book changed during restoration");
  const directory=path.join(dataDir(),"source-beat-restores",new Date().toISOString().replaceAll(":","-"));
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,"original-book.json"),JSON.stringify(original,null,2));
  await saveBook(restored);
  console.log(JSON.stringify({applied:true,backup:directory,restartWithNewGame:true}));
}
