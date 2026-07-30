import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const fixture = JSON.parse(
  readFileSync('.factory-floor/browser-smoke/fixture.json', 'utf8'),
) as {
  runId: string;
  baseUrl: string;
};

type StreamBatch = {
  url: string;
  cursor: string | null;
  ids: string[];
};

function parseStreamBatch(url: string, text: string): StreamBatch {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
    if (!frame.trim() || frame.startsWith(':')) continue;
    const lines = frame.split('\n');
    const id = lines
      .find((line) => line.startsWith('id:'))
      ?.slice(3)
      .trim();
    const eventType = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (id) cursor = id;
    if (!data) continue;
    const parsed = JSON.parse(data) as {
      id?: string;
      nextCursor?: string | null;
    };
    if (eventType === 'checkpoint' || 'nextCursor' in parsed) {
      cursor = parsed.nextCursor ?? cursor;
      continue;
    }
    const eventId = parsed.id ?? id;
    if (eventId) ids.push(eventId);
  }
  return { url, cursor, ids };
}

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function recentRuntimeEvents(page: Page) {
  return page
    .getByRole('heading', { name: 'Recent runtime events' })
    .locator('xpath=..')
    .locator('xpath=following-sibling::*[1]');
}

function liveStreamStatus(page: Page) {
  return page
    .getByText('Live stream', { exact: true })
    .locator('xpath=following-sibling::dd');
}

test.describe('production operator console', () => {
  test('continues finite SSE batches without duplicate or missing events', async ({
    page,
  }) => {
    const errors = browserErrors(page);
    const streamBatches: StreamBatch[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/api/v1/inspect/stream')) return;
      void response
        .text()
        .then((text) =>
          streamBatches.push(parseStreamBatch(response.url(), text)),
        )
        .catch(() => undefined);
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/Factory Floor/i);
    await expect(
      page.getByRole('heading', { name: 'Factory Floor' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText('ok', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Projection freshness' }),
    ).toBeVisible();

    await expect
      .poll(
        () =>
          streamBatches.findIndex((batch, index) => {
            if (index === 0 || batch.ids.length === 0) return false;
            const previous = streamBatches[index - 1];
            return (
              previous.ids.length > 0 &&
              previous.cursor !== null &&
              new URL(batch.url).searchParams.get('cursor') === previous.cursor
            );
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const continuationIndex = streamBatches.findIndex((batch, index) => {
      if (index === 0 || batch.ids.length === 0) return false;
      const previous = streamBatches[index - 1];
      return (
        previous.ids.length > 0 &&
        previous.cursor !== null &&
        new URL(batch.url).searchParams.get('cursor') === previous.cursor
      );
    });
    const continued = streamBatches.slice(
      continuationIndex - 1,
      continuationIndex + 1,
    );
    const expectedIds = [...new Set(continued.flatMap((batch) => batch.ids))];
    expect(expectedIds.length).toBeGreaterThan(continued[0].ids.length);

    const renderedIds = recentRuntimeEvents(page).locator(
      'tbody tr td:first-child button.copy',
    );
    await expect
      .poll(async () => {
        const ids = await renderedIds.evaluateAll((buttons) =>
          buttons
            .map((button) => button.getAttribute('title'))
            .filter((value): value is string => Boolean(value)),
        );
        return expectedIds.every((id) => ids.includes(id));
      })
      .toBe(true);
    const ids = await renderedIds.evaluateAll((buttons) =>
      buttons
        .map((button) => button.getAttribute('title'))
        .filter((value): value is string => Boolean(value)),
    );
    expect(new Set(ids).size).toBe(ids.length);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(
      liveStreamStatus(page).getByText('disconnected'),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(liveStreamStatus(page).getByText('live')).toBeVisible();

    const topologyLink = page.getByRole('link', { name: 'Topology' });
    await topologyLink.focus();
    await expect(topologyLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/topology$/);
    await expect(page.getByRole('heading', { name: 'Topology' })).toBeVisible();
    await expect(page.getByText('Text alternative')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('renders authenticated run, lineage, pagination, and canonical states', async ({
    page,
  }) => {
    const errors = browserErrors(page);
    let releaseRunStatus: () => void = () => {};
    const runStatusGate = new Promise<void>((resolve) => {
      releaseRunStatus = resolve;
    });
    const runStatusPath = new RegExp(`/api/v1/operator/runs/${fixture.runId}$`);
    await page.route(
      runStatusPath,
      async (route) => {
        await runStatusGate;
        await route.continue();
      },
      { times: 1 },
    );

    await page.goto(`/runs/${fixture.runId}`);
    await expect(page.getByText('Loading…').first()).toBeVisible();
    releaseRunStatus();

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
    await expect(
      page.getByRole('heading', { name: 'Run governance and lineage' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Artifact derivations' }),
    ).toBeVisible();

    const finiteEvents = page
      .getByRole('heading', { name: 'Finite run event stream' })
      .locator('xpath=ancestor::section[1]');
    const before = await finiteEvents.locator('tbody tr').count();
    const loadMore = finiteEvents.getByRole('button', { name: /load more/i });
    if ((await loadMore.count()) === 1) {
      await expect(loadMore).toBeEnabled();
      const resumeCursor = finiteEvents
        .getByText(/Resume cursor:/)
        .getByRole('button');
      await expect(resumeCursor).toHaveAttribute('title', /.+/);
      await loadMore.click();
      await expect
        .poll(() => finiteEvents.locator('tbody tr').count())
        .toBeGreaterThan(before);
    } else {
      await expect(
        finiteEvents.getByText('caught-up', { exact: true }),
      ).toBeVisible();
    }

    const unauthorized = await page.evaluate(async () => {
      const response = await fetch('/api/v1/operator/status', {
        headers: { accept: 'application/json' },
      });
      return { status: response.status };
    });
    expect(unauthorized).toEqual({ status: 401 });

    const detailsPath = new RegExp(
      `/api/v1/operator/runs/${fixture.runId}/details(?:\\?.*)?$`,
    );
    await page.route(detailsPath, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: fixture.runId,
          limits: { records: 25 },
          approvals: [],
          policyDecisions: [],
          resources: [],
          derivations: [],
          projectionFreshness: {
            scope: 'control_plane_global',
            staleAfterMs: 60_000,
            generatedAt: new Date(0).toISOString(),
            items: [],
          },
        }),
      });
    });
    await page.reload();
    await expect(
      page.getByText('No artifact derivations are associated with this run.'),
    ).toBeVisible();
    await page.unroute(detailsPath);

    await page.goto('/runs/00000000-0000-7000-8000-000000000000');
    await expect(
      page.getByText('The selected record was not found.').first(),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('keeps the production shell inside representative viewports', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  });
});
