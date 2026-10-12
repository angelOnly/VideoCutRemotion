import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { DEFAULT_CAPTION_FORMAT } from "@videocut/contracts";
import { resolveRenderBrowser } from "../packages/remotion-runtime/src/browser.js";

test("工作台正文保存不提交局部外观，全片样式单独保存，历史表单仍可用", { timeout: 60_000 }, async () => {
  const browser = await puppeteer.launch({ executablePath: await resolveRenderBrowser(), headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setContent('<div id="root"></div>');
    const bundled = await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {CaptionEditor} from './apps/web/src/App';
      import {CaptionFormatEditor} from './apps/web/src/CaptionFormatEditor';
      window.saves=[]; window.formatSaves=[];
      window.fetch=async()=>new Response(JSON.stringify({fonts:[{id:'noto-sans-sc-bold',name:'思源黑体',weight:700,style:'normal',sha256:'a'.repeat(64)}]}),{status:200});
      const format=${JSON.stringify({ ...DEFAULT_CAPTION_FORMAT, fontId: "noto-sans-sc-bold", maxLines: 2, lineHeight: 1.36 })};
      const card={id:'card',text:'准确文字',sourceText:'准确文字',startFrame:0,endFrame:24,precision:'segment_exact',style:'stable'};
      function Harness(){const [unified,setUnified]=React.useState(true); window.setUnified=setUnified;
        return <><CaptionFormatEditor format={format} disabled={false} onSave={value=>window.formatSaves.push(value)}/>
          <CaptionEditor caption={card} unified={unified} disabled={false} onSeek={()=>{}} onSave={(id,value)=>window.saves.push(value)}/></>;}
      createRoot(document.getElementById('root')).render(<Harness/>);
    `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ VITE_API_BASE: "http://127.0.0.1:1" }) } });
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    await page.waitForSelector('[data-testid="caption-card"] .caption-summary');
    await page.click('[data-testid="caption-card"] .caption-summary');
    assert.equal(await page.$('[aria-label="字幕字号：card"]'), null);
    assert.equal(await page.$('[aria-label="字幕强调短语：card"]'), null);
    await page.focus('[aria-label="字幕文案：card"]');
    await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
    await page.keyboard.type("纠正后的文字");
    await page.$$eval("button", buttons => buttons.find(button => button.textContent === "保存字幕")!.click());
    const saved = await page.evaluate(() => (window as any).saves[0]);
    assert.deepEqual(saved, { action: "update", text: "纠正后的文字", display: { mode: "shown" } });

    await page.click("details summary");
    await page.select('[aria-label="全片字幕行数"]', "1");
    await page.$$eval("button", buttons => buttons.find(button => button.textContent === "保存全片样式")!.click());
    const formatSaved = await page.evaluate(() => (window as any).formatSaves[0]);
    assert.deepEqual(formatSaved, { maxLines: 1 }, "全片修改不回传未改的字体身份、单卡正文或强调");
    assert.equal(await page.evaluate(() => (window as any).saves.length), 1);

    await page.evaluate(() => (window as any).setUnified(false));
    await page.waitForSelector('[aria-label="字幕强调短语：card"]');
    await page.$$eval("button", buttons => buttons.find(button => button.textContent === "保存字幕")!.click());
    const legacy = await page.evaluate(() => (window as any).saves[1]);
    assert.equal(legacy.format.fontSize, 32);
    assert.equal(legacy.emphasis, null);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
