import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const fixture = JSON.parse(
  readFileSync('.factory-floor/browser-smoke/fixture.json', 'utf8'),
) as {
  runId: string;
  baseUrl: string;
};

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('production operator console', () => {
  test('loads, reconnects the SSE cursor, and exposes keyboard navigation', async ({
    page,
  }) => {
    const errors = browserErrors(page);
    const streamRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/inspect/stream')) {
        streamRequests.push(request.url());
      }
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/Factory Floor/i);
    await expect(
      page.getByRole('heading', { name: 'Factory Floor' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText('healthy', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Projection freshness' }),
    ).toBeVisible();

    await expect
      .poll(() => streamRequests.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    expect(
      streamRequests.some((url) => new URL(url).searchParams.has('cursor')),
    ).toBe(true);

    const recentEvents = page
      .getByRole('heading', { name: 'Recent runtime events' })
      .locator('xpath=..')
      .locator('xpath=following-sibling::*[1]');
    const ids = await recentEvents
      .locator('tbody tr td:first-child')
      .allTextContents();
    expect(new Set(ids).size).toBe(ids.length);
    if (ids[0]) {
      await expect(recentEvents.getByText(ids[0], { exact: true })).toHaveCount(
        1,
      );
    }

    const topologyLink = page.getByRole('link', { name: 'Topology' });
    await topologyLink.focus();
    await expect(topologyLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/topology$/);
    await expect(page.getByRole('heading', { name: 'Topology' })).toBeVisible();
    await expect(page.getByText('Text alternative')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('renders authenticated run views, finite events, and canonical errors', async ({
    page,
  }) => {
    const errors = browserErrors(page);

    await page.goto(`/runs/${fixture.runId}`);
    await expect(
      page.getByRole('heading', { name: 'Run status' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Run topology' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Bounded durable trace' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Run artifacts' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Finite run event stream' }),
    ).toBeVisible();

    const finiteEvents = page
      .getByRole('heading', { name: 'Finite run event stream' })
      .locator('xpath=ancestor::section[1]');
    const before = await finiteEvents.locator('tbody tr').count();
    const loadMore = finiteEvents.getByRole('button', { name: /load more/i });
    if (await loadMore.isEnabled().catch(() => false)) {
      await loadMore.click();
      await expect
        .poll(() => finiteEvents.locator('tbody tr').count())
        .toBeGreaterThan(before);
    }
    await expect(finiteEvents.getByText(/Resume cursor:/)).toBeVisible();

    const unauthorized = await page.evaluate(async () => {
      const response = await fetch('/api/v1/operator/status', {
        headers: { accept: 'application/json' },
      });
      return { status: response.status };
    });
    expect(unauthorized).toEqual({ status: 401 });

    await page.goto('/runs/00000000-0000-7000-8000-000000000000');
    await expect(
      page.getByText('The selected record was not found.').first(),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
