import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });

test('mobile home and lobby remain usable with keyboard and touch-sized layout', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bad drawings.');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('tab', { name: 'Join friends' }).click();
  await expect(page.getByLabel('ROOM CODE OR INVITE LINK')).toBeVisible();
  await page.getByRole('tab', { name: 'Create a room' }).click();
  const avatar = page.getByRole('button', { name: 'Choose avatar 2', exact: true });
  await avatar.focus();
  await page.keyboard.press('Enter');
  await expect(avatar).toHaveAttribute('aria-pressed', 'true');
  await page.getByPlaceholder('Your excellent nickname').fill('Mobile Artist');
  await page.getByPlaceholder('Your excellent nickname').press('Enter');
  await expect(page).toHaveURL(/\/room\/[a-zA-Z0-9_-]+$/);
  await expect(page.getByRole('heading', { name: 'Let’s make a little mess.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Let’s get doodling' })).toBeDisabled();
  await page.getByLabel('Number of rounds').selectOption('1');
  await page.getByLabel('Draw time').selectOption('15');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const screenshot = testInfo.outputPath('mobile-lobby.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Mobile lobby', { path: screenshot, contentType: 'image/png' });
});
