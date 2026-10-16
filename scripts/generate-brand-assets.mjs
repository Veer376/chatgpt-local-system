import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "assets/brand");
const icons = path.join(root, "extensions/local-system/icons");
const site = path.join(root, "website");
const feature = path.join(root, "docs/assets/features");
for (const dir of [brand, icons, site, feature]) fs.mkdirSync(dir, { recursive: true });

const color = { bg:"#080B08", page:"#050706", acid:"#D4FF52", paper:"#F2F5E9", muted:"#929B8F", line:"#283326", mint:"#7CFFAD" };
const xml = s => '<?xml version="1.0" encoding="UTF-8"?>\n' + s + '\n';
const draw = `<rect width="128" height="128" rx="27" fill="${color.bg}"/>
<rect x="2" y="2" width="124" height="124" rx="25" fill="none" stroke="#34412F" stroke-width="2"/>
<!-- Bespoke 'l': a terminal stem whose foot follows the baseline. -->
<path d="M24 27H37V81H59V95H24Z" fill="${color.acid}"/>
<!-- Bespoke 's': squared terminals and routed joints, never a font glyph. -->
<path d="M101 46H79C68 46 63 52 63 60V64C63 72 69 75 79 78L87 80C90 81 92 83 92 85V87C92 89 90 90 86 90H64V101H87C100 101 105 94 105 85V82C105 74 99 70 89 67L80 64C77 63 76 61 76 59V58C76 56 78 56 81 56H101Z" fill="${color.paper}"/>`;
const mark = xml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="t d">
<title id="t">Local System</title><desc id="d">An original geometric lowercase l in phosphor green beside a routed lowercase s in off-white, on a dark rounded square.</desc>
${draw}</svg>`);
fs.writeFileSync(path.join(brand,"mark.svg"),mark);
fs.writeFileSync(path.join(icons,"local-system.svg"),mark);
fs.writeFileSync(path.join(site,"favicon.svg"),mark);

const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
const mono = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace";
const emblem=(x,y,size)=>`<g transform="translate(${x} ${y}) scale(${(size/128).toFixed(6)})">${draw}</g>`;
const t=(x,y,text,size,fill=color.paper,weight=500,extra="")=>`<text x="${x}" y="${y}" font-family="${sans}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${text}</text>`;
const m=(x,y,text,size=16,fill=color.muted,extra="")=>`<text x="${x}" y="${y}" font-family="${mono}" font-size="${size}" fill="${fill}" ${extra}>${text}</text>`;
const base=(w,h)=>`<rect width="${w}" height="${h}" rx="18" fill="${color.page}"/><rect x=".6" y=".6" width="${w-1.2}" height="${h-1.2}" rx="17.4" fill="none" stroke="#263224"/>`;
const ruler=(w,h)=>`<g stroke="#1B261A" stroke-width="1">${Array.from({length:Math.ceil(w/54)},(_,i)=>`<path d="M${i*54} 0V${h}" opacity=".17"/>`).join("")}</g>`;

const banner=xml(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="430" viewBox="0 0 1200 430" role="img" aria-labelledby="title description">
<title id="title">Local System — Your computer. Inside ChatGPT.</title>
<desc id="description">Phosphor-green ls monogram, a technical headline and a terminal file listing on a charcoal background.</desc>
${base(1200,430)}${ruler(1200,430)}
${emblem(51,42,60)}
${t(126,80,"LOCAL SYSTEM",24,color.paper,720,'letter-spacing="-0.8"')}
${m(54,152,"OPEN SOURCE   /   LOCAL-FIRST   /   11 MCP TOOLS",14,color.acid)}
${t(50,238,"Your computer.",68,color.paper,710,'letter-spacing="-3.5"')}
${t(50,314,"Inside ChatGPT.",68,color.paper,710,'letter-spacing="-3.5"')}
${m(53,383,"$ ls   →   files/   skills/   tools/   workspace/",16,color.muted)}
<rect x="785" y="35" width="367" height="362" rx="12" fill="#0D120D" stroke="#30402B"/>
${m(814,69,"❯ ls -la ~/local-system",16,color.acid)}
<path d="M811 88H1123" stroke="#2D3A2A"/>
${m(814,126,"drwx    files/",18,color.paper)}${m(1041,126,"@@",15,color.acid)}
${m(814,169,"drwx    skills/",18,color.paper)}${m(1041,169,"//",15,color.mint)}
${m(814,212,"drwx    tools/",18,color.paper)}${m(814,255,"drwx    tasks/",18,color.paper)}
${m(814,298,"drwx    workspace/",18,color.paper)}
<rect x="815" y="326" width="10" height="18" fill="${color.acid}"/>
</svg>`);
fs.writeFileSync(path.join(brand,"readme-hero.svg"),banner);
const wordmark=xml(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="112" viewBox="0 0 520 112" role="img" aria-labelledby="wtitle wdesc">
<title id="wtitle">Local System</title><desc id="wdesc">Custom green and off-white ls monogram next to the Local System wordmark.</desc>
${emblem(0,0,112)}${t(132,72,"LOCAL SYSTEM",37,color.paper,740,'letter-spacing="-1"')}
</svg>`);
fs.writeFileSync(path.join(brand,"wordmark.svg"),wordmark);


const featureMap=xml(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="505" viewBox="0 0 1200 505" role="img" aria-labelledby="title description">
<title id="title">Local System workflow: approval, preview, skills and files</title>
<desc id="description">Approval and visual feedback receive the main visual panels. Composer skills and file attachments appear as two compact rows below.</desc>
${base(1200,505)}
<g font-family="${mono}" font-size="13" fill="${color.acid}"><text x="35" y="46">01 / CONTROL</text><text x="625" y="46">02 / FEEDBACK</text></g>
<rect x="26" y="62" width="556" height="299" rx="10" fill="#101510" stroke="#34402F"/>
<rect x="609" y="62" width="565" height="299" rx="10" fill="#101510" stroke="#34402F"/>
${t(49,105,"Approval before the risky step.",25,color.paper,700,'letter-spacing="-0.7"')}
${t(633,105,"Preview. Annotate. Iterate.",25,color.paper,700,'letter-spacing="-0.7"')}
${m(49,137,"Review classified destructive operations.",12,color.muted)}
${m(633,137,"Leave precise feedback on the result.",12,color.muted)}
<rect x="52" y="169" width="500" height="167" rx="9" fill="#0B0E0B" stroke="#445537"/>
<circle cx="81" cy="198" r="14" fill="${color.acid}"/>${m(76,203,"!",17,"#061006")}
${t(105,202,"Human approval required",17,color.paper,670)}
<rect x="70" y="219" width="463" height="42" rx="5" fill="#151D12" stroke="#2D3D28"/>
${m(87,246,"rm -rf dist/",15,color.acid)}
<rect x="365" y="279" width="76" height="35" rx="5" fill="#172018" stroke="#49583D"/>${m(378,301,"Deny",12,color.paper)}
<rect x="449" y="279" width="84" height="35" rx="5" fill="${color.acid}"/>${m(459,301,"Approve",12,"#0A1208")}
<rect x="634" y="162" width="514" height="174" rx="8" fill="#ECE9E0"/>
${m(658,188,"README.md / PREVIEW",11,"#6E7968")}
${t(656,232,"Bring your computer",27,"#152016",650)}
${t(656,263,"into ChatGPT.",27,"#152016",650)}
<path d="M657 276H866" stroke="#F0905C" stroke-width="3"/>
<circle cx="872" cy="276" r="11" fill="#E67A43"/>${m(869,280,"1",10,"#ffffff")}
<rect x="909" y="266" width="218" height="58" rx="7" fill="#0B110C"/>
${m(922,286,"ANNOTATION 01",9,color.acid)}${m(922,307,"Tighten this headline",10,color.paper)}
<rect x="26" y="381" width="556" height="95" rx="9" fill="#101510" stroke="#35412F"/>
<rect x="609" y="381" width="565" height="95" rx="9" fill="#101510" stroke="#35412F"/>
${m(49,417,"//",27,color.acid)}${t(99,416,"Attach a local skill",19,color.paper,660)}
${m(99,449,"// code-review  →  SKILL.md",12,color.muted)}
${m(633,417,"@@",27,color.mint)}${t(686,416,"Attach the actual file",19,color.paper,660)}
${m(686,449,"@@ src/server.js  →  composer",12,color.muted)}
</svg>`);
fs.writeFileSync(path.join(feature,"feature-map.svg"),featureMap);

const social=xml(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
<title id="title">Local System social card</title><desc id="desc">Dark technical artwork with the green-and-white ls mark, project headline and small terminal panel.</desc>
${base(1200,630)}${ruler(1200,630)}
${emblem(63,62,86)}${t(169,121,"LOCAL SYSTEM",29,color.paper,740,'letter-spacing="-0.7"')}
${m(68,235,"$ ls    /    CHATGPT + YOUR COMPUTER",19,color.acid)}
${t(63,337,"Your computer.",74,color.paper,730,'letter-spacing="-3.6"')}
${t(63,420,"Inside ChatGPT.",74,color.paper,730,'letter-spacing="-3.6"')}
${m(67,558,"OPEN SOURCE   •   FILES   •   SKILLS   •   HUMAN APPROVAL",15,color.muted)}
<rect x="776" y="172" width="360" height="314" rx="12" fill="#0E130E" stroke="#394631"/>
${m(801,209,"❯ ls -la",17,color.acid)}
<path d="M800 230H1109" stroke="#364232"/>
${m(805,270,"files/   @@ attach",16,color.paper)}
${m(805,322,"skills/  // invoke",16,color.paper)}
${m(805,374,"tools/   11 actions",16,color.paper)}
${m(805,426,"workspace/ preview",16,color.paper)}
</svg>`);
fs.writeFileSync(path.join(brand,"social-preview.svg"),social);

async function pngAssets() {
 const executable = process.env.CHROME_PATH || [
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
   "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
 ].find(p=>fs.existsSync(p));
 if (!executable) throw new Error("Set CHROME_PATH to a local Chromium/Chrome executable to regenerate PNGs.");
 const browser=await chromium.launch({executablePath:executable,headless:true});
 try {
   const render=async (svgPath,out,width,height)=>{
     const page=await browser.newPage({viewport:{width:Math.max(width,128),height:Math.max(height,128)},deviceScaleFactor:1});
     try {
       const svg=fs.readFileSync(svgPath,"utf8");
       const url="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
       await page.setContent(`<!doctype html><html><style>html,body{margin:0;padding:0;background:transparent}img{display:block}</style><img src="${url}" width="${width}" height="${height}">`);
       await page.locator("img").evaluate(img => img.decode());
       await page.locator("img").screenshot({path:out,omitBackground:true,animations:"disabled"});
     } finally {await page.close();}
   };
   for(const size of [16,32,48,128]) {
     await render(path.join(brand,"mark.svg"),path.join(icons,`local-system-${size}.png`),size,size);
   }
   await render(path.join(brand,"social-preview.svg"),path.join(brand,"social-preview.png"),1200,630);
   fs.copyFileSync(path.join(brand,"social-preview.png"),path.join(site,"social-preview.png"));
   await render(path.join(brand,"mark.svg"),path.join(site,"apple-touch-icon.png"),180,180);
 } finally {await browser.close();}
}
await pngAssets();
console.log("Generated canonical SVGs, Chrome extension icons, website favicon/touch icon, README artwork and social preview.");
