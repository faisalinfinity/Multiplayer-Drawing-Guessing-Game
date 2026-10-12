import { test, expect, chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Player = { name: string; browser: string; context: BrowserContext; page: Page };
const baseURL = process.env.BASE_URL || 'http://localhost:3000';
test.use({ channel: undefined, trace: 'off' });

async function join(player: Player, url: string) {
  await player.page.goto(url);
  await player.page.getByPlaceholder('Your excellent nickname').fill(player.name);
  await player.page.getByRole('button', { name: 'Join this room' }).click();
  await expect(player.page.getByText('All connected', { exact: true })).toBeVisible();
}

async function canvasHash(page: Page, testId = 'drawing-canvas') {
  return page.getByTestId(testId).evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index]!, 16777619);
    return hash >>> 0;
  });
}

async function line(page: Page, points: Array<[number, number]>) {
  const canvas = page.getByTestId('drawing-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const at = ([x, y]: [number, number]) => ({ x: box.x + x * box.width / 800, y: box.y + y * box.height / 600 });
  const first = at(points[0]!);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of points.slice(1)) { const target = at(point); await page.mouse.move(target.x, target.y, { steps: 8 }); }
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function canvasClick(page: Page, x: number, y: number) {
  const box = (await page.getByTestId('drawing-canvas').boundingBox())!;
  await page.mouse.click(box.x + x * box.width / 800, box.y + y * box.height / 600);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function guess(player: Player, word: string) {
  const input = player.page.getByRole('textbox', { name: 'Your guess' });
  await expect(input).toBeEnabled();
  await input.fill(word);
  await input.press('Enter');
}

async function synchronized(players: Player[], expected: number) {
  for (const player of players) await expect.poll(() => canvasHash(player.page), { message: `${player.browser} renders identical canvas pixels` }).toBe(expected);
}

test('three browsers play a full match with private guesses, recovery, spectators and faithful replay', async ({ browserName: _browserName }, testInfo) => {
  const browsers: Browser[] = [];
  const players: Player[] = [];
  const pageErrors: string[] = [];
  const drawings: Array<{ word: string; drawer: string; hash: number }> = [];
  let failed = false;
  try {
    browsers.push(await chromium.launch(process.env.CI ? {} : { channel: 'chrome' }));
    browsers.push(await firefox.launch({ channel: undefined }));
    browsers.push(await webkit.launch({ channel: undefined }));
    for (const [index, browser] of browsers.entries()) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce' });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      if (index === 0) await page.clock.install();
      page.on('pageerror', error => pageErrors.push(`${index}: ${error.message}`));
      players.push({ context, page, name: ['Maya', 'Leo', 'Nora'][index]!, browser: ['Chrome', 'Firefox', 'WebKit'][index]! });
    }
    const host = players[0]!;
    await host.page.goto(baseURL);
    await host.page.getByPlaceholder('Your excellent nickname').fill(host.name);
    await host.page.getByRole('button', { name: 'Create a private room' }).click();
    await expect(host.page).toHaveURL(/\/room\/[a-zA-Z0-9_-]+$/);
    const invite = host.page.url();
    await Promise.all(players.slice(1).map(player => join(player, invite)));
    await expect(host.page.locator('.player-row')).toHaveCount(3);
    await host.page.getByLabel('Number of rounds').selectOption('1');
    await host.page.getByLabel('Draw time').selectOption('80');
    await host.page.getByLabel('Word collection').selectOption('custom');
    await host.page.getByLabel('Custom words').fill('elephant, rainbow, guitar');
    await host.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(host.page.getByText('Settings saved', { exact: true })).toBeVisible();
    await host.page.getByRole('button', { name: 'Let’s get doodling' }).click();

    for (let turn = 0; turn < 3; turn++) {
      await expect.poll(async () => (await Promise.all(players.map(player => player.page.getByTestId('word-choice').count()))).some(count => count === 3), { message: 'one browser privately receives three words' }).toBe(true);
      let drawer: Player | undefined;
      for (const player of players) if (await player.page.getByTestId('word-choice').count()) drawer = player;
      expect(drawer).toBeTruthy();
      const artist = drawer!;
      const choice = artist.page.getByTestId('word-choice').first();
      const word = (await choice.innerText()).trim();
      await choice.click();
      await expect(artist.page.getByTestId('secret-word')).toHaveText(word);
      const observers = players.filter(player => player !== artist);
      for (const observer of observers) {
        await expect(observer.page.getByTestId('word-hint')).not.toHaveText(word);
        await expect(observer.page.getByTestId('secret-word')).toHaveCount(0);
        await expect(observer.page.getByRole('button', { name: 'Pen', exact: true })).toHaveCount(0);
      }
      await expect.poll(() => artist.page.getByTestId('drawing-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data.every(channel => channel === 255)), { message: 'each turn starts with an opaque white canvas' }).toBe(true);
      const blank = await canvasHash(artist.page);
      await artist.page.getByRole('button', { name: turn === 1 ? 'Blue color' : turn === 2 ? 'Mint color' : 'Coral color', exact: true }).click();
      await line(artist.page, [[180 + turn * 30, 150], [500, 150], [500, 400], [180 + turn * 30, 400], [180 + turn * 30, 150]]);
      expect(pageErrors).toEqual([]);
      let finalHash = await canvasHash(artist.page);
      expect(finalHash).not.toBe(blank);
      await synchronized(observers, finalHash);

      if (turn === 0) {
        // Tool correctness must survive transport and undo, not merely look right locally.
        await artist.page.getByTestId('drawing-canvas').focus();
        await artist.page.keyboard.press('e');
        await expect(artist.page.getByRole('button', { name: 'Eraser', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await line(artist.page, [[300, 150], [350, 150]]);
        expect(await canvasHash(artist.page)).not.toBe(finalHash);
        await artist.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect.poll(() => canvasHash(artist.page)).toBe(finalHash);
        await artist.page.getByRole('button', { name: 'Mint color', exact: true }).click();
        await artist.page.getByRole('button', { name: 'Fill', exact: true }).click();
        await canvasClick(artist.page, 300, 280);
        const filled = await canvasHash(artist.page);
        expect(filled).not.toBe(finalHash);
        await synchronized(observers, filled);
        await artist.page.getByRole('button', { name: 'Clear canvas', exact: true }).click();
        await expect.poll(() => canvasHash(artist.page)).toBe(blank);
        // Four expensive canvas actions are permitted as a burst; this undo restores fill + outline.
        await artist.page.getByRole('button', { name: 'Undo', exact: true }).click();
        finalHash = filled;
        await synchronized(players, finalHash);
        const lateContext = await browsers[0]!.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce' });
        await lateContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const late: Player = { context: lateContext, page: await lateContext.newPage(), name: 'Ari', browser: 'Chrome late join' };
        players.push(late);
        await join(late, invite);
        await expect(late.page.getByRole('textbox', { name: 'Your guess' })).toBeDisabled();
        await expect(late.page.getByText('Spectating · you’re in next turn', { exact: true })).toBeVisible();
        await synchronized([late], finalHash);

        const firstGuesser = observers[0]!;
        const lastGuesser = observers[1]!;
        const near = `${word.slice(0, -1)}${word.endsWith('x') ? 'z' : 'x'}`;
        await guess(firstGuesser, near);
        await expect(firstGuesser.page.getByText('So close! You’re just one little letter away.')).toBeVisible();
        await expect(lastGuesser.page.getByText('So close! You’re just one little letter away.')).toHaveCount(0);
        await guess(firstGuesser, word.toUpperCase());
        await expect(firstGuesser.page.getByRole('textbox', { name: 'Your guess' })).toBeDisabled();
        const score = firstGuesser.page.locator('.player-row').filter({ hasText: firstGuesser.name }).getByTestId('player-score');
        const points = await score.innerText();
        expect(Number(points.replace(/\D/g, ''))).toBeGreaterThan(100);
        await firstGuesser.page.reload();
        await expect(firstGuesser.page.getByText('All connected', { exact: true })).toBeVisible();
        await expect(firstGuesser.page.locator('.player-row').filter({ hasText: firstGuesser.name }).getByTestId('player-score')).toHaveText(points);
        await expect(firstGuesser.page.getByRole('textbox', { name: 'Your guess' })).toBeDisabled();
        await synchronized([firstGuesser], finalHash);
        await expect(lastGuesser.page.getByRole('log')).not.toContainText(word.toUpperCase());
        await guess(lastGuesser, word);
      } else {
        // The spectator becomes eligible next turn but never draws in this round.
        for (const observer of observers) await guess(observer, word);
      }
      drawings.push({ word, drawer: artist.name, hash: finalHash });
      for (const player of players) await expect(player.page.getByRole('heading', { name: word, exact: true })).toBeVisible();
    }

    for (const player of players) await expect(player.page.getByRole('heading', { name: 'A round of applause.' })).toBeVisible();
    expect(drawings.map(drawing => drawing.drawer).sort()).toEqual(['Leo', 'Maya', 'Nora']);
    await expect(host.page.getByRole('button', { name: /^Replay .+ by / })).toHaveCount(3);
    for (const [index, drawing] of drawings.entries()) {
      if (index > 0) await host.page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(host.page.locator('.replay-title')).toContainText(drawing.drawer);
      const seek = host.page.getByRole('slider', { name: 'Replay position' });
      await seek.focus();
      await seek.press('End');
      await expect.poll(() => canvasHash(host.page, 'replay-canvas'), { message: 'replay final pixels match the completed live drawing' }).toBe(drawing.hash);
    }
    // Short later turns can finish before a real-time Pause click reaches the browser.
    // Control only the replay clock after the complete live match and pixel checks.
    const firstDrawing = drawings[0]!;
    await host.page.getByRole('button', { name: `Replay ${firstDrawing.word} by ${firstDrawing.drawer}`, exact: true }).click();
    await expect(host.page.locator('.replay-title')).toContainText(firstDrawing.drawer);
    await host.page.clock.pauseAt(await host.page.evaluate(() => Date.now()) + 1000);
    const seek = host.page.getByRole('slider', { name: 'Replay position' });
    await seek.press('Home');
    await expect(seek).toHaveValue('0');
    const duration = Number(await seek.getAttribute('max'));
    await host.page.getByLabel('Playback speed').selectOption('4');
    await host.page.getByRole('button', { name: 'Play replay', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
    await host.page.clock.runFor(33);
    await expect.poll(() => seek.inputValue().then(Number)).toBeGreaterThan(0);
    expect(Number(await seek.inputValue())).toBeLessThan(duration);
    await host.page.getByRole('button', { name: 'Pause replay', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
    const pausedPosition = await seek.inputValue();
    await host.page.clock.runFor(1000);
    await expect(seek).toHaveValue(pausedPosition);
    await host.page.clock.resume();
    const screenshot = testInfo.outputPath('completed-game-gallery.png');
    await host.page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('Completed gallery', { path: screenshot, contentType: 'image/png' });
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const [index, player] of players.entries()) {
      if (failed || testInfo.status !== testInfo.expectedStatus) {
        const path = testInfo.outputPath(`browser-${index}-trace.zip`);
        await player.context.tracing.stop({ path });
        await testInfo.attach(`${player.browser} trace`, { path, contentType: 'application/zip' });
        const screenshot = testInfo.outputPath(`browser-${index}-failure.png`);
        await player.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      } else await player.context.tracing.stop();
      await player.context.close();
    }
    await Promise.all(browsers.map(browser => browser.close()));
  }
});
