import fs from "node:fs";

const file = "src/components/cover-studio.tsx";
let source = fs.readFileSync(file, "utf8");
const anchor = "  Eraser,\n  Expand,";
if (!source.includes(anchor)) throw new Error("Icon import anchor not found");
source = source.replace(anchor, "  Crop,\n  Eraser,\n  Eye,\n  EyeOff,\n  Expand,\n  Lock,\n  Unlock,");
fs.writeFileSync(file, source, "utf8");
console.log("Added V2 inspector icons");
