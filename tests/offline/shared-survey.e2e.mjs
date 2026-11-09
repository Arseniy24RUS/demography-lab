/** Compiled shared entry + real persistent server + native anonymous browser fetch. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';
const evidence=resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR??join(tmpdir(),'demography-shared-survey'));
await mkdir(evidence,{recursive:true});
const dataDir=await mkdtemp(join(tmpdir(),'demography-survey-09-'));
const runtime=await openRuntime({dataDir});
const server=await startServer({runtime,port:8897,surveyPort:8898,backupIntervalMs:0});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const errors=[], outside=[], publicCalls=[], checks=[];
let lastPage;
async function context(viewport){
 const context=await browser.newContext({viewport,locale:'ru-RU',reducedMotion:'reduce',acceptDownloads:true});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(['http:','https:'].includes(url.protocol)&&url.hostname!=='127.0.0.1'){outside.push(url.origin);return route.abort();}
  return route.continue();
 });
 context.on('page',page=>{
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
   const url=new URL(request.url());
   if(url.port==='8898'&&url.pathname.startsWith('/rest/')){
    const h=request.headers();
    publicCalls.push({path:url.pathname,authorization:!!h.authorization,cookie:!!h.cookie,referer:!!h.referer});
   }
  });
 });
 return context;
}
async function login(context,email,name){
 const page=await context.newPage();lastPage=page;page.setDefaultTimeout(20000);
 await page.goto('http://127.0.0.1:8897/#sessions=1');
 await page.getByRole('textbox',{name:'Email',exact:true}).fill(email);
 await page.locator('.session-access-main').getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('textbox',{name:'Фамилия, имя, отчество',exact:true}).fill(name);
 await page.getByRole('button',{name:'Продолжить',exact:true}).click();
 await expect(page.getByRole('link',{name:'Ответить анонимно',exact:true})).toBeVisible();
 return page;
}
try{
 const desktop=await context({width:1440,height:1000});
 const first=await login(desktop,'survey-first-browser@example.test','Технический Участник');
 const firstLink=await first.getByRole('link',{name:'Ответить анонимно',exact:true}).getAttribute('href');
 assert(new URL(firstLink).port==='8898');
 await expect(first.getByRole('button',{name:/Пригласить участников|Разрешить присоединение|Создать занятие/})).toHaveCount(0);
 await first.screenshot({path:join(evidence,'shared-survey-desktop.png'),fullPage:false});
 checks.push('First participant enters ready survey without teacher or invitation');
 const mobile=await context({width:390,height:844});
 const second=await login(mobile,'survey-second-browser@example.test','Второй Участник');
 assert.equal(await second.getByRole('link',{name:'Ответить анонимно',exact:true}).getAttribute('href'),firstLink);
 await second.setViewportSize({width:320,height:844});
 assert((await second.evaluate(()=>document.documentElement.scrollWidth))<=320);
 await second.screenshot({path:join(evidence,'shared-survey-mobile-320.png'),fullPage:false});
 checks.push('Second independent browser opens same survey; mobile 320 has no overflow');
 const popup=desktop.waitForEvent('page');
 await first.getByRole('link',{name:'Ответить анонимно',exact:true}).click();
 const survey=await popup;lastPage=survey;survey.setDefaultTimeout(20000);
 await expect(survey.getByRole('heading',{name:'Что мешает родительству?',exact:true})).toBeVisible();
 await expect(survey.getByRole('textbox',{name:/Email|ФИО|Муниципалитет/i})).toHaveCount(0);
 assert.equal(await survey.evaluate(()=>document.referrer),'');
 await survey.getByRole('combobox',{name:'С какой позиции вы отвечаете?',exact:true}).selectOption('self');
 await survey.getByRole('textbox',{name:'Ответ о барьерах',exact:true}).fill('Технический пример: недоступно жильё рядом с работой.');
 await survey.getByRole('textbox',{name:'Ответ об условиях',exact:true}).fill('Технический пример: доступная аренда и ясный график работы.');
 await survey.getByRole('checkbox',{name:'Мне исполнилось 18 лет.',exact:true}).check();
 await survey.getByRole('checkbox',{name:/Я добровольно участвую/}).check();
 await survey.getByRole('button',{name:'Сохранить ответ',exact:true}).click();
 await expect(survey.getByText('Ответ сохранён.',{exact:true})).toBeVisible();
 checks.push('Native anonymous submit without account fields or referrer');
 await survey.reload();
 await expect(survey.getByRole('textbox',{name:'Ответ о барьерах',exact:true})).toHaveValue('Технический пример: недоступно жильё рядом с работой.');
 await survey.setViewportSize({width:390,height:844});
 assert((await survey.evaluate(()=>document.documentElement.scrollWidth))<=390);
 await survey.screenshot({path:join(evidence,'anonymous-form-mobile.png'),fullPage:false});
 checks.push('Own answer survives reload on separate origin; mobile form has no overflow');
 await survey.locator('summary').filter({hasText:'Управление моим ответом'}).click();
 const downloaded=survey.waitForEvent('download');
 await survey.getByRole('button',{name:'Скачать квитанцию',exact:true}).click();
 const download=await downloaded;assert.equal(download.suggestedFilename(),'survey-personal-receipt.txt');
 const note=await readFile(await download.path(),'utf8');
 assert(note.includes('Личный ключ:\n'));assert(!note.includes('responseSecret'));
 const secret=note.match(/Личный ключ:\n([a-f0-9]{64})/)?.[1];assert(secret);assert(!new URL(survey.url()).hash.includes(secret));
 const row=(await runtime.db.query('select * from research.responses')).rows[0];
 assert.equal(row.status,'submitted');assert(!('actor_id' in row));assert(!('email' in row));
 const metadata=await first.getByRole('link',{name:'Ответить анонимно',exact:true}).getAttribute('href');assert.equal(metadata,firstLink);
 await survey.getByRole('button',{name:'Удалить мой ответ',exact:true}).click();
 await survey.getByRole('dialog',{name:'Удалить мой ответ?',exact:true}).getByRole('button',{name:'Удалить мой ответ без восстановления',exact:true}).click();
 await expect(survey.getByText(/^Ваш ответ удалён\./)).toBeVisible();
 const removed=(await runtime.db.query('select answers,status from research.responses')).rows[0];assert.deepEqual(removed,{answers:null,status:'withdrawn'});
 checks.push('Text receipt and irreversible response withdrawal preserve anonymous contract');
 await first.getByRole('button',{name:'К барьерам',exact:true}).click();
 await expect(first.getByRole('button',{name:'Добавить барьер',exact:true})).toBeVisible();
 checks.push('Participant continues to shared barriers without teacher');
 assert(publicCalls.some(x=>x.path.endsWith('dw_survey_save_response')));
 assert(publicCalls.every(x=>!x.authorization&&!x.cookie&&!x.referer));
 assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
 checks.push('All survey requests omit account credentials/cookies/referrer; no external requests or browser errors');
 await writeFile(join(evidence,'report.json'),JSON.stringify({status:'passed',checks,publicCalls,errors,outside,browser:browser.version(),environment:'Linux Chromium; production offline HTTP server; not physical macOS or Wi-Fi'},null,2));
 console.log(JSON.stringify({status:'passed',checks:checks.length,publicRequests:publicCalls.length,evidence}));
} catch(error){
 if(lastPage)await lastPage.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(join(evidence,'report.json'),JSON.stringify({status:'failed',checks,publicCalls,errors,outside,error:String(error)},null,2));
 throw error;
} finally { await browser.close();await server.stop({backup:false}); }
