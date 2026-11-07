'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {_electron} = require('playwright');

// Point this only at a disposable local Worker with fresh database and bucket.
// The fixture secret deliberately belongs only to the local test service.
const origin = 'http://127.0.0.1:4183';
const operatorFixture = 'SYNTHETIC_ANNOUNCEMENT_TEST_OPERATOR_52wYp8PjpqjmQ8tR';
const token = crypto.randomBytes(6).toString('hex');
const out = path.resolve('outputs', 'announcement-qa-' + token);
const harness = path.join(out, 'electron.cjs');
const password = 'Synthetic account test passphrase ' + token + '!';
const history = [];
const errors = [];

function publish(title, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({action:'announce', title, body:'Synthetic release note <img src=x onerror=alert(1)>', version:'Build 3'});
    const headers = {'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body)};
    if (key) headers['x-raw-operator'] = key;
    const req = http.request(origin + '/api/operator', {method:'POST', headers}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.setTimeout(8000, () => req.destroy(new Error('Local operator fixture timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function signIn(page, username, register) {
  const startRegistration = page.getByRole('button', {name:'New here? Make an account', exact:true});
  const startLogin = page.getByRole('button', {name:'Already have an account? Sign in', exact:true});
  if (register && await startRegistration.isVisible()) await startRegistration.click();
  if (!register && await startLogin.isVisible()) await startLogin.click();
  await page.locator('#username').fill(username);
  await page.locator('#account-password').fill(password);
  await page.locator('.auth-card form button').click();
  await page.getByRole('navigation', {name:'Main navigation'}).waitFor();
  await page.locator('.working').waitFor({state:'hidden'});
}

async function signOut(page) {
  await page.getByRole('button', {name:'Sign out', exact:true}).click();
  await page.locator('#username').waitFor();
  await page.getByText('Signed out.', {exact:true}).waitFor();
}

async function main() {
  fs.mkdirSync(out, {recursive:true});
  fs.writeFileSync(harness, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',process.env.RAW_TEST_PROFILE);
app.whenReady().then(()=>{
  const win=new BrowserWindow({show:false,width:1250,height:940,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,partition:'raw-announcement-qa'}});
  win.webContents.session.setPermissionRequestHandler((_page,_permission,done)=>done(false));
  win.loadURL(${JSON.stringify(origin)});
});
app.on('before-quit',()=>{for(const win of BrowserWindow.getAllWindows())win.destroy();});
app.on('window-all-closed',()=>app.quit());`);

  const first = 'QA announcement one ' + token;
  const second = 'QA announcement two ' + token;
  assert.equal(await publish(first), 403);
  assert.equal(await publish(first, operatorFixture), 200);
  const app = await _electron.launch({
    executablePath:path.resolve('../node_modules/electron/dist/electron.exe'),
    args:[harness], env:{...process.env, RAW_TEST_PROFILE:path.join(out, 'profile')},
  });

  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    let announcementCalls = 0;
    page.on('request', request => {
      if (request.url() === origin + '/api/announcements') announcementCalls++;
    });
    const nav = page.getByRole('navigation', {name:'Main navigation'});
    const notice = page.getByRole('complementary', {name:'Raw announcement'});
    await page.locator('#username').waitFor();
    assert.equal(await notice.count(), 0);
    assert.equal(announcementCalls, 0);
    assert.equal((await page.evaluate(async () => (await fetch('/api/announcements', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
    })).status)), 401);
    history.push('Guest sees no notice and cannot use the signed-in feed. Operator access requires the separate key.');

    await page.clock.install();
    await signIn(page, 'qa_one_' + token, true);
    await notice.getByText(first, {exact:true}).waitFor();
    assert.equal(await notice.locator('img').count(), 0);
    assert.equal(await page.getByRole('button', {name:/send announcement|operator tools|publish announcement/i}).count(), 0);
    await nav.getByRole('button', {name:'Prompt', exact:true}).click();
    const draft = page.locator('#prompt-brief');
    await draft.fill('Synthetic unsaved prompt draft ' + token);
    await notice.getByRole('button', {name:'Dismiss', exact:true}).click();
    await notice.waitFor({state:'hidden'});
    assert.equal(await draft.inputValue(), 'Synthetic unsaved prompt draft ' + token);
    await nav.getByRole('button', {name:'Updates', exact:true}).click();
    await page.getByRole('heading', {name:first, exact:true}).waitFor();
    assert.match(await page.locator('main').innerText(), /Browser beta · build 3/);
    assert.equal(await page.getByRole('heading', {name:'Your own account. Your own workspace.', exact:true}).count(), 1);
    history.push('Plain-text notice follows navigation. Dismissal leaves the prompt draft and Updates history intact.');

    await signOut(page);
    await signIn(page, 'qa_two_' + token, true);
    await notice.getByText(first, {exact:true}).waitFor();
    await signOut(page);
    const refetch = page.waitForResponse(origin + '/api/announcements');
    await signIn(page, 'qa_one_' + token, false);
    assert.equal((await refetch).status(), 200);
    await page.clock.runFor(50);
    assert.equal(await notice.count(), 0);
    history.push('Two accounts on one browser keep separate dismissals, including after sign-out and sign-in.');

    assert.equal(await publish(second, operatorFixture), 200);
    const priorChecks = announcementCalls;
    await page.clock.fastForward(50_000);
    assert.equal(announcementCalls, priorChecks);
    const polled = page.waitForResponse(origin + '/api/announcements');
    await page.clock.fastForward(11_000);
    assert.equal((await polled).status(), 200);
    await notice.getByText(second, {exact:true}).waitFor();
    assert.equal(await notice.getByText(first, {exact:true}).count(), 0);
    await notice.getByRole('button', {name:'Read in Updates', exact:true}).click();
    await page.getByRole('heading', {name:first, exact:true}).waitFor();
    await page.getByRole('heading', {name:second, exact:true}).waitFor();
    history.push('Foreground polling is bounded to one check a minute and only the newest message gets a notice.');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenChecks = announcementCalls;
    await page.clock.fastForward(61_000);
    assert.equal(announcementCalls, hiddenChecks);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let markIntercepted;
    const intercepted = new Promise(resolve => { markIntercepted = resolve; });
    await page.route('**/api/announcements', async route => {
      markIntercepted();
      await held;
      await route.continue().catch(() => {});
    });
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(100);
    let interceptDeadline;
    try {
      await Promise.race([intercepted, new Promise((_, reject) => {
        interceptDeadline = setTimeout(() => reject(new Error('Foreground request did not resume')), 8000);
      })]);
    } finally {
      clearTimeout(interceptDeadline);
    }
    await signOut(page);
    release();
    await page.clock.runFor(100);
    assert.equal(await notice.count(), 0);
    assert.equal(await page.getByText(second, {exact:true}).count(), 0);
    history.push('Hidden tabs stop polling and a late request cannot restore a signed-out notice.');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({pass:true, scope:'Built local Worker and isolated Electron browser profile with synthetic accounts', checks:history}, null, 2));
    console.log(JSON.stringify({passed:history.length, evidence:path.relative(process.cwd(), out)}));
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
