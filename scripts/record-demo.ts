import { chromium, firefox, webkit, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, stat, writeFile, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ffmpeg from 'ffmpeg-static';

/**
 * Records a genuine three-browser match using only the visible application UI.
 * Run against the production stack: BASE_URL=http://localhost:3000 pnpm demo
 * No API calls, socket injection, mocked state, or synthetic application screens.
 */
const baseURL = process.env.BASE_URL || 'http://localhost:3000';
const output = resolve(process.env.DEMO_OUTPUT || 'artifacts/doodleroom-demo.mp4');
const raw = resolve('artifacts/raw/demo');
const totalSeconds = 120;
const viewport = { width: 1280, height: 900 };
type Participant = { name: string; browserName: string; browser: Browser; context: BrowserContext; page: Page; createdAt: number; videoPath?: string };
const participants: Participant[] = [];
const errors: string[] = [];
let startedAt = 0;

const pause = (milliseconds: number) => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
async function at(second: number, label?: string, strict = true) {
  const wait = startedAt + second * 1000 - performance.now();
  if (wait > 0) await pause(wait);
  const elapsed = (performance.now() - startedAt) / 1000;
  if (strict && elapsed > second + 3) throw new Error(`Demo fell behind at ${label || second}: ${elapsed.toFixed(1)}s, expected ${second}s`);
  if (label) console.log(`[${elapsed.toFixed(1)}s] ${label}`);
}
async function player(name: string, browserName: string, browser: Browser): Promise<Participant> {
  const context = await browser.newContext({ viewport, recordVideo: { dir: raw, size: viewport }, reducedMotion: 'reduce' });
  const createdAt = performance.now();
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(`${browserName}: ${error.message}`));
  const participant = { name, browserName, browser, context, page, createdAt };
  participants.push(participant);
  return participant;
}
async function join(person: Participant, invitation: string, avatar: number) {
  await person.page.goto(invitation);
  await person.page.getByPlaceholder('Your excellent nickname').fill(person.name);
  await person.page.getByRole('button', { name: `Choose avatar ${avatar}` }).click();
  await person.page.getByRole('button', { name: 'Join this room' }).click();
  await expect(person.page.getByText('All connected', { exact: true })).toBeVisible();
}
async function choose(person: Participant, word: string) {
  await person.page.getByRole('button', { name: word, exact: true }).click();
  await expect(person.page.getByTestId('secret-word')).toHaveText(word);
  await expect(person.page.getByRole('button', { name: 'Pen', exact: true })).toBeEnabled();
}
async function color(page: Page, name: string) {
  await page.getByRole('button', { name: `${name} color`, exact: true }).click();
}
async function pen(page: Page, name = 'Ink') {
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await color(page, name);
}
async function stroke(page: Page, points: Array<[number, number]>, steps = 2) {
  const canvas = page.getByTestId('drawing-canvas');
  const box = (await canvas.boundingBox())!;
  const position = ([x, y]: [number, number]) => ({ x: box.x + x * box.width / 800, y: box.y + y * box.height / 600 });
  const first = position(points[0]!);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    const next = position(point);
    await page.mouse.move(next.x, next.y, { steps });
  }
  await page.mouse.up();
  await pause(100);
}
function circle(x: number, y: number, radius: number, count = 28): Array<[number, number]> {
  return Array.from({ length: count + 1 }, (_, i) => [x + Math.cos(i * Math.PI * 2 / count) * radius, y + Math.sin(i * Math.PI * 2 / count) * radius]);
}
async function fill(page: Page, name: string, x: number, y: number) {
  await color(page, name);
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  const box = (await page.getByTestId('drawing-canvas').boundingBox())!;
  await page.mouse.click(box.x + x * box.width / 800, box.y + y * box.height / 600);
  await pause(250);
}
async function drawCat(page: Page) {
  await pen(page);
  await stroke(page, [[255,235],[245,115],[340,192],[405,185],[465,197],[555,115],[548,245],[564,280],[564,335],[545,385],[505,420],[450,437],[365,437],[310,420],[268,390],[245,350],[242,292],[255,235]]);
  await fill(page, 'Orange', 400, 330);
  await pen(page);
  await stroke(page, [[305,295],[321,280],[338,295]]);
  await stroke(page, [[463,295],[480,280],[495,295]]);
  await stroke(page, [[384,326],[402,341],[420,326],[384,326]]);
  await stroke(page, [[402,341],[400,359],[387,367],[372,357]]);
  await stroke(page, [[400,359],[414,367],[429,357]]);
  await stroke(page, [[284,333],[205,314]]);
  await stroke(page, [[282,354],[207,369]]);
  await stroke(page, [[521,333],[603,314]]);
  await stroke(page, [[523,354],[602,369]]);
  await pen(page, 'Coral');
  await stroke(page, [[638,190],[679,229],[646,259]]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
}
async function drawRocket(page: Page) {
  await pen(page);
  await stroke(page, [[400,92],[441,143],[471,213],[472,367],[330,367],[331,213],[359,143],[400,92]]);
  await fill(page, 'Sky', 400, 315);
  await pen(page);
  await stroke(page, circle(401,238,42), 1);
  await fill(page, 'White', 401, 238);
  await pen(page, 'Coral');
  await stroke(page, [[328,279],[283,325],[263,396],[329,370],[328,279]]);
  await stroke(page, [[474,279],[520,325],[541,396],[473,370],[474,279]]);
  await pen(page, 'Orange');
  await stroke(page, [[348,383],[348,442],[372,423],[402,492],[430,423],[452,442],[452,383]]);
  await pen(page, 'Yellow');
  await stroke(page, [[383,388],[401,442],[420,388]]);
}
async function drawFlower(page: Page) {
  await pen(page, 'Mint');
  await stroke(page, [[400,293],[399,368],[405,450],[400,516]]);
  await stroke(page, [[401,417],[340,399],[306,351],[362,365],[401,417]]);
  await stroke(page, [[403,458],[454,431],[483,387],[435,405],[403,458]]);
  await pen(page, 'Coral');
  const petals: Array<[number, number]> = Array.from({ length: 76 }, (_, i) => {
    const angle = i * Math.PI * 2 / 75;
    const radius = 92 + 37 * Math.cos(5 * angle);
    return [400 + radius * Math.cos(angle), 246 + radius * Math.sin(angle)];
  });
  await stroke(page, petals, 1);
  await fill(page, 'Pink', 400, 246);
  await pen(page, 'Ink');
  await stroke(page, circle(400,246,39), 1);
  await fill(page, 'Yellow', 400, 246);
  await pen(page, 'Ink');
  await stroke(page, [[383,241],[383,245]]);
  await stroke(page, [[418,241],[418,245]]);
  await stroke(page, [[385,262],[400,268],[416,260]]);
}
async function guess(person: Participant, word: string) {
  const input = person.page.getByTestId('guess-input');
  await expect(input).toBeEnabled();
  await input.fill(word);
  await input.press('Enter');
}
async function verifyCanvas(person: Participant) {
  await expect.poll(() => person.page.getByTestId('drawing-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255 && pixels[i]! < 220) ink++;
    return ink;
  })).toBeGreaterThan(1000);
}
async function findFont(): Promise<string | undefined> {
  for (const candidate of [process.env.DEMO_FONT, '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* Try the next platform font. */ }
  }
}
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', chunk => { tail = (tail + String(chunk)).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`Encoder exited ${code}: ${tail}`)));
  });
}
type Source = { name: string; browserName: string; videoPath: string; trimSeconds: number; duration?: number };
async function compose(sources: Source[]) {
  if (!ffmpeg) throw new Error('ffmpeg-static did not provide an executable. Reinstall dependencies.');
  const sourceArgs = sources.flatMap(source => ['-i', source.videoPath]);
  const inputs = sources.map((source, index) => {
    const start = Math.max(0, source.trimSeconds).toFixed(3);
    const size = index === 0 ? '1280:900' : '640:450';
    return `[${index}:v]trim=start=${start}${source.duration === undefined ? '' : `:duration=${source.duration}`},setpts=PTS-STARTPTS,fps=30,scale=${size}:flags=lanczos,tpad=stop_mode=clone:stop_duration=125[p${index}]`;
  });
  const font = await findFont();
  const decorations: string[] = [];
  async function caption(text: string, x: number, y: number, size: number, color: string, range?: [number, number]) {
    if (!font) return;
    const path = resolve(raw, `caption-${decorations.length}.txt`);
    await writeFile(path, text);
    const safe = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");
    decorations.push(`drawtext=fontfile='${safe(font)}':textfile='${safe(path)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${range ? `:enable='between(t,${range[0]},${range[1] - 0.001})'` : ''}`);
  }
  // Browser labels/captions are editorial overlays; every view comes from a real browser recording.
  await caption('ADA  /  GOOGLE CHROME', 980, 12, 17, '#766779');
  await caption('MILO  /  FIREFOX', 1740, 8, 11, '#766779');
  await caption('ZOE  /  WEBKIT', 1740, 458, 11, '#766779');
  await caption('DOODLEROOM', 42, 932, 20, '#d87970');
  await caption('Three real browsers. One shared canvas.', 42, 968, 34, '#29283e');
  await caption('Create a room, invite friends, and choose your own words.', 42, 1026, 22, '#847883', [0,16]);
  await caption('Live drawing: pen, color, fill, and undo stream to every player.', 42, 1026, 22, '#847883', [16,29]);
  await caption('Private close feedback. Faster correct guesses earn more points.', 42, 1026, 22, '#847883', [29,33]);
  await caption('Refresh a browser: the canvas, identity, and score return.', 42, 1026, 22, '#847883', [33,40]);
  await caption('The next player becomes the artist. The server runs every turn.', 42, 1026, 22, '#847883', [40,62]);
  await caption('Three turns. Three independent browsers. Everyone gets to draw.', 42, 1026, 22, '#847883', [62,84]);
  await caption('Final scores and a replay of every drawing.', 42, 1026, 22, '#847883', [84,100]);
  await caption('Replay the original strokes. Pause, seek, or change the speed.', 42, 1026, 22, '#847883', [100,120]);
  const filter = `${inputs.join(';')};[p0][p1][p2]xstack=inputs=3:layout=0_0|1280_0|1280_450:fill=#faf8f1,pad=1920:1080:0:0:color=#faf8f1${decorations.length ? `,${decorations.join(',')}` : ''}[out]`;
  console.log('Encoding the 120-second three-browser recording…');
  await run(ffmpeg, ['-y', ...sourceArgs, '-filter_complex', filter, '-map', '[out]', '-t', String(totalSeconds), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
  const info = await stat(output);
  if (info.size > 25 * 1024 * 1024) throw new Error(`Recording is ${(info.size / 1024 / 1024).toFixed(1)} MiB, over the 25 MiB artifact budget.`);
  console.log(`Saved ${output} (${(info.size / 1024 / 1024).toFixed(1)} MiB).`);
}

await mkdir(raw, { recursive: true });
await mkdir(resolve(output, '..'), { recursive: true });
if (process.env.DEMO_SOURCE_METADATA) {
  const metadata = JSON.parse(await readFile(resolve(process.env.DEMO_SOURCE_METADATA), 'utf8')) as { players: Source[] };
  await compose(metadata.players);
} else {
try {
  const ada = await player('Ada', 'Google Chrome', await chromium.launch({ channel: 'chrome' }));
  const milo = await player('Milo', 'Firefox', await firefox.launch());
  const zoe = await player('Zoe', 'WebKit', await webkit.launch());
  await Promise.all(participants.map(person => person.page.goto(baseURL)));
  await Promise.all(participants.map(person => expect(person.page.getByPlaceholder('Your excellent nickname')).toBeVisible()));
  startedAt = performance.now();
  for (const person of participants) person.videoPath = await person.page.video()!.path();
  await writeFile(resolve(raw, 'recording.json'), JSON.stringify({ baseURL, recordedAt: new Date().toISOString(), seconds: totalSeconds, players: participants.map(({ name, browserName, videoPath, createdAt }) => ({ name, browserName, videoPath, trimSeconds: (startedAt - createdAt) / 1000 })) }, null, 2));
  console.log(`Recording three independent browsers at ${baseURL}.`);
  await at(2, 'Ada creates a private room');
  await ada.page.getByPlaceholder('Your excellent nickname').fill('Ada');
  await ada.page.getByRole('button', { name: 'Choose avatar 2' }).click();
  await ada.page.getByRole('button', { name: 'Create a private room' }).click();
  await expect(ada.page).toHaveURL(/\/room\/[a-zA-Z0-9_-]+$/);
  const invitation = ada.page.url();
  await at(6, 'Milo joins in Firefox'); await join(milo, invitation, 3);
  await at(9, 'Zoe joins in WebKit'); await join(zoe, invitation, 4);
  await at(12, 'Host configures a three-word game');
  await expect(ada.page.locator('.player-row')).toHaveCount(3);
  await ada.page.getByLabel('Number of rounds').selectOption('1');
  await ada.page.getByLabel('Draw time').selectOption('30');
  await ada.page.getByLabel('Word collection').selectOption('custom');
  await ada.page.getByLabel('Custom words').fill('kitten, rocket, flower');
  await ada.page.getByRole('button', { name: 'Save settings' }).click();
  await expect(ada.page.getByText('Settings saved', { exact: true })).toBeVisible();
  await at(16, 'Start the match'); await ada.page.getByRole('button', { name: 'Let’s get doodling' }).click();
  await at(17, 'Ada draws a kitten with pen, fill, and undo'); await choose(ada, 'kitten'); await drawCat(ada.page);
  await Promise.all(participants.map(verifyCanvas));
  await at(29, 'Milo gets private close feedback'); await guess(milo, 'kittan');
  await expect(milo.page.getByText('So close! You’re just one little letter away.')).toBeVisible();
  await expect(zoe.page.getByText('So close! You’re just one little letter away.')).toHaveCount(0);
  await at(31, 'Milo guesses correctly'); await guess(milo, 'kitten');
  const score = milo.page.locator('.player-row').filter({ hasText: 'Milo' }).getByTestId('player-score');
  await expect.poll(() => score.innerText().then(text => Number(text.replace(/\D/g, '')))).toBeGreaterThan(100);
  const before = await score.innerText();
  await at(33, 'Milo refreshes and keeps his score'); await milo.page.reload();
  await expect(milo.page.getByText('All connected', { exact: true })).toBeVisible();
  await expect(milo.page.locator('.player-row').filter({ hasText: 'Milo' }).getByTestId('player-score')).toHaveText(before);
  await verifyCanvas(milo);
  await at(36, 'Zoe finishes the first turn'); await guess(zoe, 'kitten');
  await expect(ada.page.getByRole('heading', { name: 'kitten', exact: true })).toBeVisible();
  await at(41, 'Milo takes the pencil'); await choose(milo, 'rocket'); await drawRocket(milo.page);
  await at(54, 'Ada guesses rocket'); await guess(ada, 'rocket');
  await at(57, 'Zoe guesses rocket'); await guess(zoe, 'rocket');
  await expect(milo.page.getByRole('heading', { name: 'rocket', exact: true })).toBeVisible();
  await at(62, 'Zoe draws a flower'); await choose(zoe, 'flower'); await drawFlower(zoe.page);
  await at(77, 'Ada guesses flower'); await guess(ada, 'flower');
  await at(80, 'Milo completes the game'); await guess(milo, 'flower');
  await at(85, 'Final scores arrive in all three browsers');
  await Promise.all(participants.map(person => expect(person.page.getByRole('heading', { name: 'A round of applause.' })).toBeVisible()));
  await at(88, 'Replay the first drawing');
  await Promise.all(participants.map(person => person.page.locator('#the-gallery').scrollIntoViewIfNeeded()));
  await ada.page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await milo.page.getByRole('button', { name: 'Next', exact: true }).click();
  await milo.page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await zoe.page.getByRole('button', { name: 'Next', exact: true }).click();
  await zoe.page.getByRole('button', { name: 'Next', exact: true }).click();
  await zoe.page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await at(100, 'Switch drawings and speed up playback');
  await ada.page.getByRole('button', { name: 'Next', exact: true }).click();
  await ada.page.getByLabel('Playback speed').selectOption('4');
  await ada.page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await at(106, 'Seek back to the first stroke');
  await ada.page.getByRole('slider', { name: 'Replay position' }).focus();
  await ada.page.getByRole('slider', { name: 'Replay position' }).press('Home');
  await at(108, 'Seek to the completed drawing');
  await ada.page.getByRole('slider', { name: 'Replay position' }).focus();
  await ada.page.getByRole('slider', { name: 'Replay position' }).press('End');
  await at(112, 'The last masterpiece');
  await ada.page.getByRole('button', { name: 'Next', exact: true }).click();
  await ada.page.getByLabel('Playback speed').selectOption('4');
  await ada.page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await at(totalSeconds, 'Recording complete', false);
  expect(errors, 'All three browser pages stayed free of runtime errors').toEqual([]);
} finally {
  await Promise.all(participants.map(async person => {
    const video = person.page.video();
    await person.context.close();
    if (video) person.videoPath = await video.path();
    await person.browser.close();
  }));
}
await writeFile(resolve(raw, 'recording.json'), JSON.stringify({ baseURL, recordedAt: new Date().toISOString(), seconds: totalSeconds, players: participants.map(({ name, browserName, videoPath, createdAt }) => ({ name, browserName, videoPath, trimSeconds: (startedAt - createdAt) / 1000 })) }, null, 2));
await compose(participants.map(({ name, browserName, videoPath, createdAt }) => ({ name, browserName, videoPath: videoPath!, trimSeconds: (startedAt - createdAt) / 1000 })));
}
