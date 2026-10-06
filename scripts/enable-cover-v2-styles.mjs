import fs from "node:fs";

const file = "src/app/cover/page.tsx";
let source = fs.readFileSync(file, "utf8");
const anchor = 'import "./cover-studio.css";';
if (!source.includes(anchor)) throw new Error("Cover style import anchor not found");
source = source.replace(anchor, `${anchor}\nimport "./cover-studio-v2.css";`);
fs.writeFileSync(file, source, "utf8");
console.log("Enabled cover V2 styles");
