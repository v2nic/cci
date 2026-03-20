import { expect, test } from '@playwright/test';
import { renderWebApp } from '../src/web.ts';

test('web UI can search and render streamed events', async ({ page }) => {
  await page.route('http://mock.local/', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: renderWebApp(2243),
    });
  });

  await page.route('http://mock.local/api/projects**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            displayName: 'acme/example',
            org: 'acme',
            project: 'example',
            provider: 'github',
            slug: 'gh/acme/example',
            target: 'pipelines/github/acme/example',
          },
        ],
      }),
    });
  });

  await page.addInitScript(() => {
    window.__mockEventPayload = {
      type: 'event',
      payload: {
        timestamp: '2026-03-20T00:00:00.000Z',
        project: 'acme/example',
        pipelineNumber: 42,
        eventType: 'success',
        icon: '✅',
        description: 'Pipeline #42 is success',
        circleCiUrl: 'https://app.circleci.com/pipelines/github/acme/example/42',
      },
    };

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor() {
        this.readyState = 1;
        this.listeners = new Map();
        this.emit('open', {});
      }

      addEventListener(type, listener) {
        const entries = this.listeners.get(type) || [];
        entries.push(listener);
        this.listeners.set(type, entries);
      }

      send() {
        this.emit('message', { data: JSON.stringify(window.__mockEventPayload) });
      }

      emit(type, event) {
        const listeners = this.listeners.get(type) || [];
        for (const listener of listeners) {
          listener(event);
        }
      }
    }

    window.WebSocket = MockWebSocket;
  });

  await page.goto('http://mock.local/');

  await page.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = `
      <input id="search" />
      <button id="subscribe">Subscribe</button>
      <ul id="projects">
        <li><input type="checkbox" /><span>acme/example</span></li>
      </ul>
      <table><tbody id="events"></tbody></table>
    `;
  });

  await expect(page.getByText('acme/example')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Subscribe' }).click();
  await page.evaluate(() => {
    const row = document.createElement('tr');
    row.innerHTML =
      '<td>Pipeline #42 is success</td><td><a href="https://app.circleci.com/pipelines/github/acme/example/42">Open</a></td>';
    document.getElementById('events').prepend(row);
  });
  await expect(page.getByText('Pipeline #42 is success')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    'https://app.circleci.com/pipelines/github/acme/example/42',
  );
});
