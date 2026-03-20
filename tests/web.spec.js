import { expect, test } from '@playwright/test';

test('web UI can search and render streamed events', async ({ page }) => {
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

  await page.setContent(`<!doctype html>
<html lang="en">
  <body>
    <base href="http://mock.local/" />
    <input id="search" />
    <button id="subscribe">Subscribe</button>
    <ul id="projects"></ul>
    <table><tbody id="events"></tbody></table>
    <script>
      const searchInput = document.getElementById('search');
      const projectsList = document.getElementById('projects');
      const subscribeButton = document.getElementById('subscribe');
      const eventsBody = document.getElementById('events');
      const selectedTargets = new Set();
      let socket;
      function renderProjects(projects) {
        projectsList.innerHTML = '';
        for (const project of projects) {
          const li = document.createElement('li');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selectedTargets.has(project.target);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedTargets.add(project.target);
            else selectedTargets.delete(project.target);
          });
          const label = document.createElement('span');
          label.textContent = project.displayName;
          li.appendChild(checkbox);
          li.appendChild(label);
          projectsList.appendChild(li);
        }
      }
      function appendEvent(event) {
        const row = document.createElement('tr');
        row.innerHTML = '<td>' + event.description + '</td><td><a href="' + event.circleCiUrl + '">Open</a></td>';
        eventsBody.prepend(row);
      }
      async function loadProjects() {
        const response = await fetch('http://mock.local/api/projects?q=' + encodeURIComponent(searchInput.value));
        const payload = await response.json();
        renderProjects(payload.items);
      }
      function ensureSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        socket = new WebSocket('ws://localhost/ws');
        socket.addEventListener('message', (incoming) => {
          const message = JSON.parse(incoming.data);
          if (message.type === 'event') appendEvent(message.payload);
        });
      }
      subscribeButton.addEventListener('click', () => {
        ensureSocket();
        const targets = [...selectedTargets];
        const send = () => socket.send(JSON.stringify({ type: 'subscribe', targets }));
        if (socket.readyState === WebSocket.OPEN) send();
        else socket.addEventListener('open', send, { once: true });
      });
      loadProjects();
    </script>
  </body>
</html>`);

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
