import { parseChapterUrl } from "./parser.js";
const c = [
  "https://www.mangaread.org/manga/blue-lock/chapter-350/",
  "https://www.natomanga.com/manga/call-of-the-spear/chapter-246",
  "https://www.mangaread.org/manga/tales-of-demons-and-gods/chapter-520-5/",
];
for (const u of c){ const r=parseChapterUrl(u); console.log(r? `OK ${r.id} ch ${r.chapter}`:`null ${u}`);}
