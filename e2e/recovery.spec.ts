import { expect, test, type Page } from '@playwright/test';

async function hash(page: Page) {
  return page.getByTestId('drawing-canvas').evaluate((canvas: HTMLCanvasElement) => {
    let value = 2166136261;
    for (const channel of canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data) value = Math.imul(value ^ channel, 16777619);
    return value >>> 0;
  });
}
test('a lost drawing event and dropped synchronization request recover without refreshing', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  let drawingDropped = false;
  let syncRequests = 0;
  await guest.routeWebSocket(url => url.pathname.startsWith('/socket.io/'), socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      if (typeof message === 'string' && message.includes('["drawing",') && !drawingDropped) { drawingDropped = true; return; }
      socket.send(message);
    });
    socket.onMessage(message => {
      if (typeof message === 'string' && message.includes('["sync"')) { syncRequests++; if (syncRequests === 1) return; }
      server.send(message);
    });
  });
  try {
    await host.goto(baseURL!);
    await host.getByPlaceholder('Your excellent nickname').fill('Artist');
    await host.getByRole('button', { name: 'Create a private room' }).click();
    await expect(host).toHaveURL(/\/room\//);
    await guest.goto(host.url());
    await guest.getByPlaceholder('Your excellent nickname').fill('Observer');
    await guest.getByRole('button', { name: 'Join this room' }).click();
    await expect(host.locator('.player-row')).toHaveCount(2);
    await host.getByRole('button', { name: 'Let’s get doodling' }).click();
    await host.getByTestId('word-choice').first().click();
    await expect(host.getByRole('button', { name: 'Pen', exact: true })).toBeVisible();
    const blank = await hash(host);
    const box = (await host.getByTestId('drawing-canvas').boundingBox())!;
    await host.mouse.move(box.x + 40, box.y + 40);
    await host.mouse.down();
    await host.mouse.move(box.x + 180, box.y + 180, { steps: 30 });
    await host.mouse.up();
    await host.mouse.click(box.x + 220, box.y + 220);
    await expect.poll(() => hash(host)).not.toBe(blank);
    await expect.poll(() => syncRequests).toBeGreaterThanOrEqual(2);
    const expected = await hash(host);
    await expect.poll(() => hash(guest)).toBe(expected);
    expect(drawingDropped).toBe(true);
  } finally { await hostContext.close(); await guestContext.close(); }
});
